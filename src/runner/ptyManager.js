import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import pty from "node-pty";
import throttle from "lodash.throttle";
import stripAnsi from "strip-ansi";
import { formatPtyOutput, splitTelegramMessage } from "../bot/formatter.js";

function isMessageNotModified(error) {
  return String(error?.description || error?.message || "").includes("message is not modified");
}

function isPtySpawnFailure(error) {
  return String(error?.message || "").includes("posix_spawnp failed");
}

export class PtyManager {
  constructor({ bot, config }) {
    this.bot = bot;
    this.config = config;
    this.sessions = new Map();
    this.chatState = new Map();
  }

  ensureChatState(chatId) {
    const key = String(chatId);
    const existing = this.chatState.get(key);
    if (existing) return existing;

    const state = {
      preferredModel: null,
      currentWorkdir: this.config.runner.cwd,
      ptySupported: null,
      lastMode: null,
      lastExitCode: null,
      lastExitSignal: null
    };

    this.chatState.set(key, state);
    return state;
  }

  getCommandArgsForSession(chatId) {
    const state = this.ensureChatState(chatId);
    const args = [...this.config.runner.args];
    if (state.preferredModel) {
      args.push("-m", state.preferredModel);
    }
    return args;
  }

  getWorkdir(chatId) {
    const state = this.ensureChatState(chatId);
    return state.currentWorkdir || this.config.runner.cwd;
  }

  getRelativeWorkdir(chatId) {
    const workdir = this.getWorkdir(chatId);
    const relative = path.relative(this.config.workspace.root, workdir);
    return relative || ".";
  }

  isInsideWorkspaceRoot(candidate) {
    const root = path.resolve(this.config.workspace.root);
    const target = path.resolve(candidate);
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  listProjects() {
    const root = this.config.workspace.root;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const projects = [];

    if (fs.existsSync(path.join(root, ".git"))) {
      projects.push({
        name: path.basename(root),
        path: root,
        relativePath: "."
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(root, entry.name);
      if (!fs.existsSync(path.join(fullPath, ".git"))) continue;

      projects.push({
        name: entry.name,
        path: fullPath,
        relativePath: entry.name
      });
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  switchWorkdir(chatId, targetName) {
    const key = String(chatId);
    const requested = String(targetName || "").trim();
    if (!requested) {
      throw new Error("Project name is required.");
    }

    const root = this.config.workspace.root;
    let targetPath;

    if (requested === "." || requested === path.basename(root)) {
      targetPath = root;
    } else {
      targetPath = path.resolve(root, requested);
    }

    if (!this.isInsideWorkspaceRoot(targetPath)) {
      throw new Error("Target path is outside WORKSPACE_ROOT.");
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new Error(`Project directory does not exist: ${targetPath}`);
    }

    if (!fs.existsSync(path.join(targetPath, ".git"))) {
      throw new Error(`Target is not a git repository: ${targetPath}`);
    }

    const state = this.ensureChatState(key);
    state.currentWorkdir = targetPath;
    this.closeSession(key);

    return {
      workdir: targetPath,
      relativePath: path.relative(root, targetPath) || "."
    };
  }

  getExecArgs(chatId, prompt, options = {}) {
    const state = this.ensureChatState(chatId);
    const args = ["exec"];

    if (options.fullAuto) {
      args.push("--full-auto");
    }

    if (state.preferredModel) {
      args.push("-m", state.preferredModel);
    }

    if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
      args.push(...options.extraArgs);
    }

    args.push(prompt);
    return args;
  }

  createBaseSession(chatId, mode) {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const session = {
      chatId: key,
      mode,
      model: state.preferredModel,
      proc: null,
      rawBuffer: "",
      streamMessageIds: [],
      lastRendered: "",
      flushQueue: Promise.resolve(),
      throttledFlush: null,
      write: null,
      interrupt: null,
      close: null
    };

    session.throttledFlush = throttle(
      () => this.enqueueFlush(key),
      this.config.runner.throttleMs,
      { leading: true, trailing: true }
    );

    this.sessions.set(key, session);
    return session;
  }

  attachOutput(session, stream) {
    stream.on("data", (chunk) => {
      session.rawBuffer += stripAnsi(String(chunk || "")).replace(/\r/g, "");
      if (session.rawBuffer.length > this.config.runner.maxBufferChars) {
        session.rawBuffer = session.rawBuffer.slice(-this.config.runner.maxBufferChars);
      }
      session.throttledFlush();
    });
  }

  attachExit(session, handler) {
    handler(async ({ exitCode, signal }) => {
      const state = this.ensureChatState(session.chatId);
      state.lastMode = session.mode;
      state.lastExitCode = exitCode;
      state.lastExitSignal = signal;

      this.enqueueFlush(session.chatId);
      await this.bot.telegram
        .sendMessage(
          session.chatId,
          `Codex session exited (mode=${session.mode}, code=${exitCode}, signal=${signal}).`
        )
        .catch(() => {});
      session.throttledFlush?.cancel();
      this.sessions.delete(session.chatId);
    });
  }

  startPtySession(chatId) {
    const session = this.createBaseSession(chatId, "pty");
    const proc = pty.spawn(this.config.runner.command, this.getCommandArgsForSession(chatId), {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: this.getWorkdir(chatId),
      env: {
        ...process.env,
        FORCE_COLOR: "1"
      }
    });

    this.ensureChatState(chatId).ptySupported = true;
    session.proc = proc;
    session.write = (input) => proc.write(input);
    session.interrupt = () => proc.write("\u0003");
    session.close = () => proc.kill();

    proc.onData((chunk) => {
      session.rawBuffer += stripAnsi(String(chunk || "")).replace(/\r/g, "");
      if (session.rawBuffer.length > this.config.runner.maxBufferChars) {
        session.rawBuffer = session.rawBuffer.slice(-this.config.runner.maxBufferChars);
      }
      session.throttledFlush();
    });

    this.attachExit(session, (listener) => proc.onExit(listener));
    return session;
  }

  startExecSessionWithOptions(chatId, prompt, options = {}) {
    const session = this.createBaseSession(chatId, "exec");
    const proc = spawn(this.config.runner.command, this.getExecArgs(chatId, prompt, options), {
      cwd: this.getWorkdir(chatId),
      env: process.env
    });

    session.proc = proc;
    session.write = null;
    session.interrupt = () => proc.kill("SIGINT");
    session.close = () => proc.kill("SIGTERM");

    this.attachOutput(session, proc.stdout);
    this.attachOutput(session, proc.stderr);
    this.attachExit(session, (listener) =>
      proc.on("close", (exitCode, signal) => listener({ exitCode, signal }))
    );

    proc.on("error", async (error) => {
      await this.bot.telegram
        .sendMessage(session.chatId, `Codex exec failed: ${error.message}`)
        .catch(() => {});
      session.throttledFlush?.cancel();
      this.sessions.delete(session.chatId);
    });

    return session;
  }

  ensureSession(chatId) {
    const key = String(chatId);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    try {
      return this.startPtySession(key);
    } catch (error) {
      if (!isPtySpawnFailure(error)) {
        throw error;
      }

      this.ensureChatState(key).ptySupported = false;
      console.warn(`[runner] PTY spawn failed for chat ${key}; falling back to codex exec mode.`);
      return null;
    }
  }

  enqueueFlush(chatId) {
    const key = String(chatId);
    const session = this.sessions.get(key);
    if (!session) return;

    session.flushQueue = session.flushQueue
      .then(() => this.flushToTelegram(key))
      .catch(() => {});
  }

  async flushToTelegram(chatId) {
    const session = this.sessions.get(chatId);
    if (!session) return;

    const rawTail = session.rawBuffer.slice(-60000);
    const rendered = formatPtyOutput(rawTail, { mode: this.config.reasoning.mode });
    if (rendered === session.lastRendered) return;
    session.lastRendered = rendered;

    const chunks = splitTelegramMessage(rendered, this.config.runner.telegramChunkSize);
    const existing = session.streamMessageIds;
    const nextIds = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const existingMessageId = existing[i];

      if (existingMessageId) {
        try {
          await this.bot.telegram.editMessageText(chatId, existingMessageId, undefined, chunk, {
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true
          });
          nextIds.push(existingMessageId);
        } catch (error) {
          if (!isMessageNotModified(error)) {
            const sent = await this.bot.telegram.sendMessage(chatId, chunk, {
              parse_mode: "MarkdownV2",
              disable_web_page_preview: true
            });
            nextIds.push(sent.message_id);
          } else {
            nextIds.push(existingMessageId);
          }
        }
      } else {
        const sent = await this.bot.telegram.sendMessage(chatId, chunk, {
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true
        });
        nextIds.push(sent.message_id);
      }
    }

    for (let i = chunks.length; i < existing.length; i += 1) {
      const staleId = existing[i];
      await this.bot.telegram.deleteMessage(chatId, staleId).catch(() => {});
    }

    session.streamMessageIds = nextIds;
  }

  async sendPrompt(ctx, prompt, options = {}) {
    const chatId = String(ctx.chat.id);
    if (options.forceExec) {
      const running = this.sessions.get(chatId);
      if (running) {
        return {
          started: false,
          reason: "busy",
          activeMode: running.mode
        };
      }

      this.startExecSessionWithOptions(chatId, prompt, {
        fullAuto: Boolean(options.fullAuto),
        extraArgs: options.extraArgs || []
      });

      if (options.notice) {
        await this.bot.telegram.sendMessage(chatId, options.notice);
      }

      return {
        started: true,
        mode: "exec"
      };
    }

    let session = this.ensureSession(chatId);

    if (!session) {
      session = this.startExecSessionWithOptions(chatId, prompt, {
        fullAuto: Boolean(options.fullAuto),
        extraArgs: options.extraArgs || []
      });
      await this.bot.telegram.sendMessage(
        chatId,
        "PTY unavailable on this host. Falling back to `codex exec` mode for this request."
      );
      return {
        started: true,
        mode: "exec",
        fallback: true
      };
    }

    if (!session.streamMessageIds.length) {
      const sent = await this.bot.telegram.sendMessage(
        chatId,
        `Codex session started (${session.mode}). Streaming output...`
      );
      session.streamMessageIds.push(sent.message_id);
    }

    if (session.mode === "exec") {
      return {
        started: false,
        reason: "busy",
        activeMode: session.mode
      };
    }

    session.write(`${prompt}\r`);
    return {
      started: true,
      mode: "pty"
    };
  }

  interrupt(chatId) {
    const session = this.sessions.get(String(chatId));
    if (!session) return false;
    session.interrupt?.();
    return true;
  }

  closeSession(chatId) {
    const key = String(chatId);
    const session = this.sessions.get(key);
    if (!session) return false;

    session.throttledFlush?.cancel();
    session.close?.();
    this.sessions.delete(key);
    return true;
  }

  async shutdown() {
    for (const chatId of this.sessions.keys()) {
      this.closeSession(chatId);
    }
  }

  getStatus(chatId) {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const session = this.sessions.get(key);

    return {
      active: Boolean(session),
      activeMode: session?.mode || null,
      lastMode: state.lastMode,
      lastExitCode: state.lastExitCode,
      lastExitSignal: state.lastExitSignal,
      preferredModel: state.preferredModel,
      ptySupported: state.ptySupported,
      workdir: this.getWorkdir(key),
      relativeWorkdir: this.getRelativeWorkdir(key),
      workspaceRoot: this.config.workspace.root,
      command: this.config.runner.command,
      mcpServers: this.config.mcp.servers.map((server) => server.name)
    };
  }

  setPreferredModel(chatId, model) {
    const state = this.ensureChatState(chatId);
    state.preferredModel = model?.trim() || null;
    return state.preferredModel;
  }

  clearPreferredModel(chatId) {
    const state = this.ensureChatState(chatId);
    state.preferredModel = null;
  }
}
