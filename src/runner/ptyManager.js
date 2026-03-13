import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import pty from "node-pty";
import throttle from "lodash.throttle";
import stripAnsi from "strip-ansi";
import { formatPtyOutput, splitTelegramMessage } from "../bot/formatter.js";
import { normalizeLanguage, t } from "../bot/i18n.js";

function isMessageNotModified(error) {
  return String(error?.description || error?.message || "").includes("message is not modified");
}

function isPtySpawnFailure(error) {
  return String(error?.message || "").includes("posix_spawnp failed");
}

function extractSessionId(rawText) {
  const matched = String(rawText || "").match(/session id:\s*([0-9a-f-]{36})/i);
  return matched?.[1] || "";
}

export class PtyManager {
  constructor({ bot, config, onChange }) {
    this.bot = bot;
    this.config = config;
    this.onChange = onChange;
    this.sessions = new Map();
    this.chatState = new Map();
  }

  ensureChatState(chatId) {
    const key = String(chatId);
    const existing = this.chatState.get(key);
    if (existing) return existing;

    const state = {
      preferredModel: null,
      language: "en",
      verboseOutput: false,
      currentWorkdir: this.config.runner.cwd,
      recentWorkdirs: [this.config.runner.cwd],
      ptySupported: null,
      projectStates: new Map([
        [
          this.config.runner.cwd,
          {
            lastSessionId: "",
            lastMode: null,
            lastExitCode: null,
            lastExitSignal: null
          }
        ]
      ])
    };

    this.chatState.set(key, state);
    return state;
  }

  ensureProjectState(chatId, workdir = this.getWorkdir(chatId)) {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const resolvedWorkdir = path.resolve(workdir || state.currentWorkdir || this.config.runner.cwd);
    const existing = state.projectStates.get(resolvedWorkdir);
    if (existing) return existing;

    const projectState = {
      lastSessionId: "",
      lastMode: null,
      lastExitCode: null,
      lastExitSignal: null
    };

    state.projectStates.set(resolvedWorkdir, projectState);
    return projectState;
  }

  getCommandArgsForSession(chatId) {
    const state = this.ensureChatState(chatId);
    const args = [...this.config.runner.args];
    if (state.preferredModel) {
      args.push("-m", state.preferredModel);
    }
    return args;
  }

  isVerbose(chatId) {
    const state = this.ensureChatState(chatId);
    return Boolean(state.verboseOutput);
  }

  getLanguage(chatId) {
    const state = this.ensureChatState(chatId);
    return normalizeLanguage(state.language) || "en";
  }

  setLanguage(chatId, language) {
    const normalized = normalizeLanguage(language);
    if (!normalized) {
      throw new Error("Unsupported language.");
    }

    const state = this.ensureChatState(chatId);
    state.language = normalized;
    this.onChange?.(this.exportState());
    return normalized;
  }

  setVerbose(chatId, enabled) {
    const state = this.ensureChatState(chatId);
    state.verboseOutput = Boolean(enabled);
    this.onChange?.(this.exportState());
    return state.verboseOutput;
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

  getProjectState(chatId, workdir = this.getWorkdir(chatId)) {
    return this.ensureProjectState(chatId, workdir);
  }

  rememberWorkdir(state, workdir) {
    const history = [workdir, ...(state.recentWorkdirs || []).filter((item) => item !== workdir)];
    state.recentWorkdirs = history.slice(0, 6);
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

  getRecentProjects(chatId) {
    const state = this.ensureChatState(chatId);
    return (state.recentWorkdirs || [])
      .filter((workdir) => fs.existsSync(workdir) && this.isInsideWorkspaceRoot(workdir))
      .map((workdir) => ({
        path: workdir,
        relativePath: path.relative(this.config.workspace.root, workdir) || "."
      }));
  }

  switchWorkdir(chatId, targetName) {
    const key = String(chatId);
    const requested = String(targetName || "").trim();
    if (!requested) {
      throw new Error(t(this.getLanguage(key), "projectNameRequired"));
    }

    const root = this.config.workspace.root;
    let targetPath;

    if (requested === "." || requested === path.basename(root)) {
      targetPath = root;
    } else {
      targetPath = path.resolve(root, requested);
    }

    if (!this.isInsideWorkspaceRoot(targetPath)) {
      throw new Error(t(this.getLanguage(key), "targetOutsideWorkspaceRoot"));
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new Error(t(this.getLanguage(key), "projectDirDoesNotExist", { path: targetPath }));
    }

    if (!fs.existsSync(path.join(targetPath, ".git"))) {
      throw new Error(t(this.getLanguage(key), "targetNotGitRepository", { path: targetPath }));
    }

    const state = this.ensureChatState(key);
    this.ensureProjectState(key, targetPath);
    state.currentWorkdir = targetPath;
    this.rememberWorkdir(state, targetPath);
    this.closeSession(key);
    this.onChange?.(this.exportState());

    return {
      workdir: targetPath,
      relativePath: path.relative(root, targetPath) || "."
    };
  }

  switchToPreviousWorkdir(chatId) {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const previous = (state.recentWorkdirs || []).find((workdir) => workdir !== state.currentWorkdir);

    if (!previous) {
      throw new Error(t(this.getLanguage(key), "noPreviousProject"));
    }

    return this.switchWorkdir(key, previous);
  }

  getExecArgs(chatId, prompt, options = {}) {
    const state = this.ensureChatState(chatId);
    const args = options.resumeSessionId ? ["exec", "resume"] : ["exec"];

    if (options.fullAuto) {
      args.push("--full-auto");
    }

    if (state.preferredModel) {
      args.push("-m", state.preferredModel);
    }

    if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
      args.push(...options.extraArgs);
    }

    if (options.resumeSessionId) {
      args.push(options.resumeSessionId);
    }

    args.push(prompt);
    return args;
  }

  getInteractiveArgs(chatId, options = {}) {
    const args = options.resumeSessionId
      ? ["resume", options.resumeSessionId]
      : this.getCommandArgsForSession(chatId);

    if (options.resumeSessionId && options.initialPrompt) {
      args.push(options.initialPrompt);
    }

    return args;
  }

  createBaseSession(chatId, mode, options = {}) {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const workdir = path.resolve(options.workdir || state.currentWorkdir || this.config.runner.cwd);
    const projectState = this.ensureProjectState(key, workdir);
    const session = {
      chatId: key,
      mode,
      workdir,
      model: state.preferredModel,
      sessionId: projectState.lastSessionId || "",
      trackConversation: options.trackConversation !== false,
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

  captureSessionMetadata(session) {
    if (!session.trackConversation) return;

    const sessionId = extractSessionId(session.rawBuffer);
    if (!sessionId || sessionId === session.sessionId) return;

    session.sessionId = sessionId;
    const projectState = this.ensureProjectState(session.chatId, session.workdir);
    projectState.lastSessionId = sessionId;
    this.onChange?.(this.exportState());
  }

  attachOutput(session, stream) {
    stream.on("data", (chunk) => {
      session.rawBuffer += stripAnsi(String(chunk || "")).replace(/\r/g, "");
      if (session.rawBuffer.length > this.config.runner.maxBufferChars) {
        session.rawBuffer = session.rawBuffer.slice(-this.config.runner.maxBufferChars);
      }
      this.captureSessionMetadata(session);
      session.throttledFlush();
    });
  }

  attachExit(session, handler) {
    handler(async ({ exitCode, signal }) => {
      this.captureSessionMetadata(session);
      const projectState = this.ensureProjectState(session.chatId, session.workdir);
      projectState.lastMode = session.mode;
      projectState.lastExitCode = exitCode;
      projectState.lastExitSignal = signal;
      this.onChange?.(this.exportState());

      this.enqueueFlush(session.chatId);
      if (this.isVerbose(session.chatId)) {
        await this.bot.telegram
          .sendMessage(
            session.chatId,
            t(this.getLanguage(session.chatId), "codexSessionExited", {
              mode: session.mode,
              exitCode,
              signal
            })
          )
          .catch(() => {});
      }
      session.throttledFlush?.cancel();
      this.sessions.delete(session.chatId);
    });
  }

  startPtySession(chatId, options = {}) {
    const session = this.createBaseSession(chatId, "pty", options);
    const proc = pty.spawn(this.config.runner.command, this.getInteractiveArgs(chatId, options), {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: session.workdir,
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
      this.captureSessionMetadata(session);
      session.throttledFlush();
    });

    this.attachExit(session, (listener) => proc.onExit(listener));
    return session;
  }

  startExecSessionWithOptions(chatId, prompt, options = {}) {
    const session = this.createBaseSession(chatId, "exec", options);
    const proc = spawn(this.config.runner.command, this.getExecArgs(chatId, prompt, options), {
      cwd: session.workdir,
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
        .sendMessage(
          session.chatId,
          t(this.getLanguage(session.chatId), "codexExecFailed", {
            error: error.message
          })
        )
        .catch(() => {});
      session.throttledFlush?.cancel();
      this.sessions.delete(session.chatId);
    });

    return session;
  }

  ensureSession(chatId, options = {}) {
    const key = String(chatId);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    try {
      return this.startPtySession(key, options);
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
    const rendered = formatPtyOutput(rawTail, {
      mode: this.config.reasoning.mode,
      sessionMode: session.mode
    });
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
    const projectState = this.ensureProjectState(chatId);
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
        extraArgs: options.extraArgs || [],
        workdir: this.getWorkdir(chatId),
        trackConversation: false
      });

      if (options.notice && this.isVerbose(chatId)) {
        await this.bot.telegram.sendMessage(chatId, options.notice);
      }

      return {
        started: true,
        mode: "exec"
      };
    }

    const existingSession = this.sessions.get(chatId);
    if (existingSession) {
      if (existingSession.mode === "exec") {
        return {
          started: false,
          reason: "busy",
          activeMode: existingSession.mode
        };
      }

      existingSession.write(`${prompt}\r`);
      return {
        started: true,
        mode: "pty"
      };
    }

    let session = this.ensureSession(
      chatId,
      projectState.lastSessionId
        ? {
            workdir: this.getWorkdir(chatId),
            resumeSessionId: projectState.lastSessionId,
            initialPrompt: prompt
          }
        : {
            workdir: this.getWorkdir(chatId)
          }
    );

    if (!session) {
      session = this.startExecSessionWithOptions(chatId, prompt, {
        fullAuto: Boolean(options.fullAuto),
        extraArgs: options.extraArgs || [],
        workdir: this.getWorkdir(chatId),
        resumeSessionId: projectState.lastSessionId || ""
      });
      if (this.isVerbose(chatId)) {
        await this.bot.telegram.sendMessage(
          chatId,
          projectState.lastSessionId
            ? t(this.getLanguage(chatId), "execFallbackResume")
            : t(this.getLanguage(chatId), "execFallbackSingle")
        );
      }
      return {
        started: true,
        mode: "exec",
        fallback: true,
        resumed: Boolean(projectState.lastSessionId)
      };
    }

    if (!session.streamMessageIds.length && this.isVerbose(chatId)) {
      const sent = await this.bot.telegram.sendMessage(
        chatId,
        projectState.lastSessionId
          ? t(this.getLanguage(chatId), "sessionRestored", {
              project: this.getRelativeWorkdir(chatId),
              mode: session.mode
            })
          : t(this.getLanguage(chatId), "sessionStarted", {
              mode: session.mode
            })
      );
      session.streamMessageIds.push(sent.message_id);
    }

    if (projectState.lastSessionId) {
      return {
        started: true,
        mode: "pty",
        resumed: true
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

  resetCurrentProjectConversation(chatId) {
    const key = String(chatId);
    const workdir = this.getWorkdir(key);
    const projectState = this.ensureProjectState(key, workdir);
    const closed = this.closeSession(key);

    projectState.lastSessionId = "";
    projectState.lastMode = null;
    projectState.lastExitCode = null;
    projectState.lastExitSignal = null;
    this.onChange?.(this.exportState());

    return {
      closed,
      workdir
    };
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

  serializeWorkdir(workdir) {
    const relative = path.relative(this.config.workspace.root, workdir);
    if (!relative) return ".";
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : workdir;
  }

  resolveStoredWorkdir(stored) {
    if (!stored || typeof stored !== "string") return null;
    const candidate = path.isAbsolute(stored)
      ? path.resolve(stored)
      : path.resolve(this.config.workspace.root, stored);

    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      return null;
    }

    if (!this.isInsideWorkspaceRoot(candidate)) {
      return null;
    }

    return candidate;
  }

  exportState() {
    const chats = {};

    for (const [chatId, state] of this.chatState.entries()) {
      const projects = {};
      for (const [workdir, projectState] of state.projectStates.entries()) {
        projects[this.serializeWorkdir(workdir)] = {
          lastSessionId: projectState.lastSessionId || "",
          lastMode: projectState.lastMode,
          lastExitCode: projectState.lastExitCode,
          lastExitSignal: projectState.lastExitSignal
        };
      }

      chats[chatId] = {
        preferredModel: state.preferredModel,
        language: this.getLanguage(chatId),
        verboseOutput: Boolean(state.verboseOutput),
        currentWorkdir: this.serializeWorkdir(state.currentWorkdir),
        recentWorkdirs: (state.recentWorkdirs || []).map((workdir) => this.serializeWorkdir(workdir)),
        projects
      };
    }

    return {
      chats
    };
  }

  restoreState(snapshot = {}) {
    const chats = snapshot?.chats;
    if (!chats || typeof chats !== "object") return;

    this.chatState.clear();

    for (const [chatId, rawState] of Object.entries(chats)) {
      const currentWorkdir =
        this.resolveStoredWorkdir(rawState?.currentWorkdir) || this.config.runner.cwd;

      const recentWorkdirs = Array.isArray(rawState?.recentWorkdirs)
        ? rawState.recentWorkdirs
            .map((stored) => this.resolveStoredWorkdir(stored))
            .filter(Boolean)
        : [];

      const projectStates = new Map();
      const rawProjects = rawState?.projects;
      if (rawProjects && typeof rawProjects === "object") {
        for (const [storedWorkdir, rawProjectState] of Object.entries(rawProjects)) {
          const resolvedWorkdir = this.resolveStoredWorkdir(storedWorkdir);
          if (!resolvedWorkdir) continue;

          projectStates.set(resolvedWorkdir, {
            lastSessionId: String(rawProjectState?.lastSessionId || "").trim(),
            lastMode: rawProjectState?.lastMode || null,
            lastExitCode:
              rawProjectState?.lastExitCode === null || rawProjectState?.lastExitCode === undefined
                ? null
                : rawProjectState.lastExitCode,
            lastExitSignal: rawProjectState?.lastExitSignal || null
          });
        }
      }

      if (!projectStates.has(currentWorkdir)) {
        projectStates.set(currentWorkdir, {
          lastSessionId: "",
          lastMode: null,
          lastExitCode: null,
          lastExitSignal: null
        });
      }

      this.chatState.set(String(chatId), {
        preferredModel: rawState?.preferredModel?.trim?.() || null,
        language: normalizeLanguage(rawState?.language) || "en",
        verboseOutput: Boolean(rawState?.verboseOutput),
        currentWorkdir,
        recentWorkdirs: [currentWorkdir, ...recentWorkdirs.filter((workdir) => workdir !== currentWorkdir)].slice(0, 6),
        ptySupported: null,
        projectStates
      });
    }
  }

  getStatus(chatId) {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const projectState = this.ensureProjectState(key, state.currentWorkdir);
    const session = this.sessions.get(key);

    return {
      active: Boolean(session),
      activeMode: session?.mode || null,
      lastMode: projectState.lastMode,
      lastExitCode: projectState.lastExitCode,
      lastExitSignal: projectState.lastExitSignal,
      projectSessionId: projectState.lastSessionId || null,
      preferredModel: state.preferredModel,
      language: this.getLanguage(key),
      verboseOutput: Boolean(state.verboseOutput),
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
    this.onChange?.(this.exportState());
    return state.preferredModel;
  }

  clearPreferredModel(chatId) {
    const state = this.ensureChatState(chatId);
    state.preferredModel = null;
    this.onChange?.(this.exportState());
  }
}
