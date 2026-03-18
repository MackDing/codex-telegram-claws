import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PtyManager } from "../src/runner/ptyManager.js";

type PtyManagerConstructorOptions = ConstructorParameters<typeof PtyManager>[0];
type TelegramStub = PtyManagerConstructorOptions["bot"]["telegram"];
type CodexClientFactory = NonNullable<
  PtyManagerConstructorOptions["codexClientFactory"]
>;

interface ManagerOverrides {
  runnerCwd?: string;
  workspaceRoot?: string;
  telegram?: TelegramStub;
  backend?: PtyManagerConstructorOptions["config"]["runner"]["backend"];
  codexClientFactory?: CodexClientFactory;
}

interface FakeSequence {
  initialId?: string | null;
  events: () => AsyncGenerator<unknown>;
}

type FakeCall =
  | { action: "start"; options: Record<string, unknown> }
  | { action: "resume"; id: string; options: Record<string, unknown> };

interface SentMessageRecord {
  chatId: string | number;
  text?: string;
  messageId?: number;
  edited?: boolean;
  document?: unknown;
  photo?: unknown;
  video?: unknown;
  audio?: unknown;
  options?: Record<string, unknown>;
}

function createManager(overrides: ManagerOverrides = {}) {
  const runnerCwd = overrides.runnerCwd || process.cwd();
  const workspaceRoot = overrides.workspaceRoot || runnerCwd;
  const telegram: TelegramStub = overrides.telegram || {
    sendMessage: async () => ({ message_id: 1 }),
    sendDocument: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 1 }),
    sendVideo: async () => ({ message_id: 1 }),
    sendAudio: async () => ({ message_id: 1 }),
    editMessageText: async () => ({}),
    deleteMessage: async () => ({})
  };
  return new PtyManager({
    bot: {
      telegram
    },
    config: {
      runner: {
        backend: overrides.backend || "cli",
        command: "codex",
        args: [],
        cwd: runnerCwd,
        throttleMs: 10,
        maxBufferChars: 1000,
        telegramChunkSize: 3900,
        sdkConfig: {},
        sdkThreadOptions: {
          skipGitRepoCheck: true,
          additionalDirectories: []
        }
      },
      workspace: {
        root: workspaceRoot
      },
      reasoning: {
        mode: "spoiler"
      },
      mcp: {
        servers: [
          {
            name: "context7",
            command: "npx",
            args: [],
            cwd: runnerCwd,
            env: {}
          },
          {
            name: "sequential-thinking",
            command: "npx",
            args: [],
            cwd: runnerCwd,
            env: {}
          }
        ]
      }
    },
    codexClientFactory: overrides.codexClientFactory
  });
}

function createFakeCodexClient(
  sequences: FakeSequence[],
  calls: FakeCall[] = []
): CodexClientFactory {
  return (() => ({
    startThread(options: Record<string, unknown> = {}) {
      const next = sequences.shift();
      if (!next) {
        throw new Error("No fake SDK sequence available for startThread");
      }

      calls.push({
        action: "start",
        options
      });

      return {
        id: next.initialId || null,
        async runStreamed() {
          return {
            events: next.events()
          };
        }
      };
    },
    resumeThread(id: string, options: Record<string, unknown> = {}) {
      const next = sequences.shift();
      if (!next) {
        throw new Error("No fake SDK sequence available for resumeThread");
      }

      calls.push({
        action: "resume",
        id,
        options
      });

      return {
        id: next.initialId || id,
        async runStreamed() {
          return {
            events: next.events()
          };
        }
      };
    }
  })) as CodexClientFactory;
}

function createExecFallbackSession(
  chatId: string,
  workdir = process.cwd(),
  mode: "exec" | "sdk" | "pty" = "exec"
): ReturnType<PtyManager["startExecSessionWithOptions"]> {
  return {
    mode,
    streamMessageIds: [],
    chatId,
    workdir
  } as unknown as ReturnType<PtyManager["startExecSessionWithOptions"]>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out while waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("pty manager stores model preference per chat", () => {
  const manager = createManager();

  manager.setPreferredModel(123, "gpt-5-codex");
  const status = manager.getStatus(123);

  assert.equal(status.preferredModel, "gpt-5-codex");

  manager.clearPreferredModel(123);
  assert.equal(manager.getStatus(123).preferredModel, null);
});

test("pty manager stores verbose preference per chat", () => {
  const manager = createManager();

  assert.equal(manager.isVerbose(123), false);
  manager.setVerbose(123, true);
  assert.equal(manager.isVerbose(123), true);
  assert.equal(manager.getStatus(123).verboseOutput, true);
});

test("pty manager stores language preference per chat", () => {
  const manager = createManager();

  assert.equal(manager.getLanguage(123), "en");
  manager.setLanguage(123, "zh-HK");
  assert.equal(manager.getLanguage(123), "zh-HK");
  assert.equal(manager.getStatus(123).language, "zh-HK");
});

test("pty manager status exposes runner workdir and MCP server names", () => {
  const manager = createManager();
  const status = manager.getStatus(456);

  assert.equal(status.workdir, process.cwd());
  assert.equal(status.relativeWorkdir, ".");
  assert.equal(status.workspaceRoot, process.cwd());
  assert.deepEqual(status.mcpServers, ["context7", "sequential-thinking"]);
  assert.equal(status.active, false);
  assert.equal(status.workflowPhase, "none");
});

test("pty manager tracks the last detected superpowers workflow phase per project", async () => {
  const manager = createManager({
    backend: "sdk",
    codexClientFactory: createFakeCodexClient([
      {
        events: async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "item-1",
              type: "agent_message",
              text: "I’m using `brainstorming` first, then `writing-plans`."
            }
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1
            }
          };
        }
      }
    ])
  });

  await manager.sendPrompt({ chat: { id: 7 } }, "design the change");
  await waitFor(() => !manager.getStatus(7).active);

  assert.equal(manager.getStatus(7).workflowPhase, "brainstorming");
});

test("pty manager lists git projects under workspace root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-workspace-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  const projects = manager.listProjects();

  assert.deepEqual(
    projects.map((project) => project.relativePath),
    ["project-a", "project-b"]
  );
});

test("pty manager switches workdir within workspace root and resets session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-switch-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  const result = manager.switchWorkdir(99, "project-b");

  assert.equal(result.relativePath, "project-b");
  assert.equal(manager.getStatus(99).workdir, projectB);
  assert.equal(manager.getStatus(99).relativeWorkdir, "project-b");
});

test("pty manager tracks recent projects and can switch back to the previous workdir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-history-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const projectC = path.join(root, "project-c");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(projectC, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));
  fs.mkdirSync(path.join(projectC, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  manager.switchWorkdir(77, "project-b");
  manager.switchWorkdir(77, "project-c");

  assert.deepEqual(
    manager.getRecentProjects(77).map((project) => project.relativePath),
    ["project-c", "project-b", "project-a"]
  );

  const previous = manager.switchToPreviousWorkdir(77);

  assert.equal(previous.relativePath, "project-b");
  assert.equal(manager.getStatus(77).relativeWorkdir, "project-b");
});

test("pty manager keeps project conversation slots isolated per workdir", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claws-project-sessions-")
  );
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  manager.getProjectState(55, projectA).lastSessionId =
    "11111111-1111-1111-1111-111111111111";
  manager.switchWorkdir(55, "project-b");
  manager.getProjectState(55, projectB).lastSessionId =
    "22222222-2222-2222-2222-222222222222";

  assert.equal(
    manager.getStatus(55).projectSessionId,
    "22222222-2222-2222-2222-222222222222"
  );

  manager.switchWorkdir(55, "project-a");
  assert.equal(
    manager.getStatus(55).projectSessionId,
    "11111111-1111-1111-1111-111111111111"
  );
});

test("pty manager exports and restores per-project conversation state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-project-export-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });
  manager.getProjectState(99, projectA).lastSessionId =
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  manager.switchWorkdir(99, "project-b");
  manager.getProjectState(99, projectB).lastSessionId =
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  const restored = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });
  restored.restoreState(manager.exportState());

  assert.equal(restored.getStatus(99).relativeWorkdir, "project-b");
  assert.equal(
    restored.getStatus(99).projectSessionId,
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
  );
  restored.switchWorkdir(99, "project-a");
  assert.equal(
    restored.getStatus(99).projectSessionId,
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
});

test("pty manager exports and restores verbose preference", () => {
  const manager = createManager();
  manager.setVerbose(42, true);

  const restored = createManager();
  restored.restoreState(manager.exportState());

  assert.equal(restored.isVerbose(42), true);
});

test("pty manager exports and restores language preference", () => {
  const manager = createManager();
  manager.setLanguage(42, "zh");

  const restored = createManager();
  restored.restoreState(manager.exportState());

  assert.equal(restored.getLanguage(42), "zh");
});

test("pty manager stores SDK thread ids per project and resumes them", async () => {
  const calls: FakeCall[] = [];
  const sentMessages: SentMessageRecord[] = [];
  const sequences = [
    {
      events: async function* () {
        yield {
          type: "thread.started",
          thread_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        };
        yield {
          type: "item.completed",
          item: {
            id: "item-1",
            type: "agent_message",
            text: "Project A ready."
          }
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1
          }
        };
      }
    },
    {
      events: async function* () {
        yield {
          type: "item.completed",
          item: {
            id: "item-2",
            type: "agent_message",
            text: "Project A resumed."
          }
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1
          }
        };
      }
    }
  ];
  const manager = createManager({
    backend: "sdk",
    telegram: {
      sendMessage: async (chatId: string | number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
      },
      editMessageText: async (
        chatId: string | number,
        messageId: number,
        _inlineMessageId: string | undefined,
        text: string
      ) => {
        sentMessages.push({ chatId, messageId, text, edited: true });
        return {};
      },
      deleteMessage: async () => ({})
    },
    codexClientFactory: createFakeCodexClient(sequences, calls)
  });

  await manager.sendPrompt({ chat: { id: 9 } }, "remember project a");
  await waitFor(() => !manager.getStatus(9).active);

  assert.equal(
    manager.getStatus(9).projectSessionId,
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  );
  assert.equal(calls[0].action, "start");
  assert.equal(calls[0].options.workingDirectory, process.cwd());
  const firstMessage = sentMessages.at(-1);
  if (!firstMessage) {
    throw new Error("Expected at least one Telegram message");
  }
  if (!firstMessage.text) {
    throw new Error("Expected the Telegram record to include text");
  }
  assert.match(firstMessage.text, /Project A ready/);

  await manager.sendPrompt({ chat: { id: 9 } }, "continue project a");
  await waitFor(() => !manager.getStatus(9).active);

  assert.equal(calls[1].action, "resume");
  assert.equal(calls[1].id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const resumedMessage = sentMessages.at(-1);
  if (!resumedMessage) {
    throw new Error("Expected a resumed Telegram message");
  }
  if (!resumedMessage.text) {
    throw new Error("Expected the resumed Telegram record to include text");
  }
  assert.match(resumedMessage.text, /Project A resumed/);
});

test("pty manager does not persist SDK thread ids for one-off runs", async () => {
  const calls: FakeCall[] = [];
  const manager = createManager({
    backend: "sdk",
    codexClientFactory: createFakeCodexClient(
      [
        {
          events: async function* () {
            yield {
              type: "thread.started",
              thread_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
            };
            yield {
              type: "item.completed",
              item: {
                id: "item-1",
                type: "agent_message",
                text: "One-off result."
              }
            };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1
              }
            };
          }
        }
      ],
      calls
    )
  });

  const result = await manager.sendPrompt({ chat: { id: 12 } }, "run once", {
    forceExec: true
  });
  await waitFor(() => !manager.getStatus(12).active);

  assert.equal(result.started, true);
  assert.equal(result.mode, "sdk");
  assert.equal(manager.getStatus(12).projectSessionId, null);
  assert.equal(calls[0].action, "start");
});

test("pty manager hides exec fallback notices when verbose output is off", async () => {
  const sentMessages: SentMessageRecord[] = [];
  const manager = createManager({
    telegram: {
      sendMessage: async (chatId: string | number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    }
  });

  manager.ensureSession = () => null;
  manager.startExecSessionWithOptions = () => createExecFallbackSession("77");

  await manager.sendPrompt({ chat: { id: 77 } }, "who are u");

  assert.equal(sentMessages.length, 0);
});

test("pty manager blocks a prompt when another chat is active in the same workdir", async () => {
  const manager = createManager({
    backend: "sdk",
    codexClientFactory: createFakeCodexClient([
      {
        events: async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "item-1",
              type: "agent_message",
              text: "should not run"
            }
          };
        }
      }
    ])
  });

  manager.sessions.set(
    "2",
    createExecFallbackSession("2", process.cwd(), "sdk")
  );

  const result = await manager.sendPrompt({ chat: { id: 1 } }, "edit files");

  assert.deepEqual(result, {
    started: false,
    reason: "workspace_busy",
    activeMode: "sdk",
    blockingChatId: "2",
    relativeWorkdir: "."
  });
});

test("pty manager replays a blocked prompt once through the continue path", async () => {
  const calls: FakeCall[] = [];
  const manager = createManager({
    backend: "sdk",
    codexClientFactory: createFakeCodexClient(
      [
        {
          initialId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          events: async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "item-continue",
                type: "agent_message",
                text: "continued"
              }
            };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1
              }
            };
          }
        }
      ],
      calls
    )
  });

  manager.sessions.set(
    "2",
    createExecFallbackSession("2", process.cwd(), "sdk")
  );

  const blocked = await manager.sendPrompt(
    { chat: { id: 1 } },
    "apply patch and run tests"
  );

  assert.equal(blocked.started, false);
  assert.equal(blocked.reason, "workspace_busy");

  manager.sessions.delete("2");

  const continued = await manager.continuePendingPrompt({
    chat: { id: 1 }
  });

  assert.equal(continued.started, true);
  assert.equal(continued.mode, "sdk");
  await waitFor(() => !manager.getStatus(1).active);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "start");

  const nonePending = await manager.continuePendingPrompt({
    chat: { id: 1 }
  });

  assert.deepEqual(nonePending, {
    started: false,
    reason: "no_pending_prompt"
  });
});

test("pty manager shows exec fallback notices when verbose output is on", async () => {
  const sentMessages: SentMessageRecord[] = [];
  const manager = createManager({
    telegram: {
      sendMessage: async (chatId: string | number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    }
  });

  manager.setVerbose(77, true);
  manager.ensureSession = () => null;
  manager.startExecSessionWithOptions = () => createExecFallbackSession("77");

  await manager.sendPrompt({ chat: { id: 77 } }, "who are u");

  assert.equal(sentMessages.length, 1);
  if (!sentMessages[0].text) {
    throw new Error("Expected the fallback notice to include text");
  }
  assert.match(sentMessages[0].text, /Interactive terminal is unavailable/);
});

test("pty manager sends Telegram typing actions while a session is active", async () => {
  const chatActions: Array<{ chatId: string | number; action: string }> = [];
  let releaseTurn = () => {};
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = () => resolve();
  });
  const manager = createManager({
    backend: "sdk",
    telegram: {
      sendMessage: async () => ({ message_id: 1 }),
      sendChatAction: async (chatId: string | number, action: string) => {
        chatActions.push({ chatId, action });
        return {};
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    },
    codexClientFactory: createFakeCodexClient([
      {
        events: async function* () {
          await turnReleased;
          yield {
            type: "item.completed",
            item: {
              id: "item-1",
              type: "agent_message",
              text: "done"
            }
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1
            }
          };
        }
      }
    ])
  });

  await manager.sendPrompt({ chat: { id: 88 } }, "wait a bit");
  await waitFor(() => chatActions.length > 0);

  assert.deepEqual(chatActions[0], { chatId: "88", action: "typing" });
  releaseTurn();
  await waitFor(() => !manager.getStatus(88).active);
});

test("pty manager sends changed files back to Telegram after an SDK run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-artifacts-"));
  fs.writeFileSync(path.join(root, "report.txt"), "artifact body");
  const sentMessages: SentMessageRecord[] = [];

  const manager = createManager({
    backend: "sdk",
    runnerCwd: root,
    workspaceRoot: root,
    telegram: {
      sendMessage: async (chatId: string | number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
      },
      sendChatAction: async () => ({}),
      sendDocument: async (
        chatId: string | number,
        document: unknown,
        options?: Record<string, unknown>
      ) => {
        sentMessages.push({ chatId, document, options });
        return { message_id: sentMessages.length };
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    },
    codexClientFactory: createFakeCodexClient([
      {
        events: async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "item-file",
              type: "file_change",
              changes: [{ kind: "write", path: "report.txt" }]
            }
          };
          yield {
            type: "item.completed",
            item: {
              id: "item-msg",
              type: "agent_message",
              text: "generated report"
            }
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1
            }
          };
        }
      }
    ])
  });

  await manager.sendPrompt({ chat: { id: 33 } }, "make a report");
  await waitFor(() => !manager.getStatus(33).active);

  const artifact = sentMessages.find((entry) => Boolean(entry.document));
  assert.ok(artifact);
  assert.equal(artifact.chatId, "33");
  assert.deepEqual(artifact.options, {
    caption: "Generated file: report.txt"
  });
});

test("pty manager announces the file list when multiple artifacts are being sent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-batch-artifacts-"));
  fs.writeFileSync(path.join(root, "a.txt"), "A");
  fs.writeFileSync(path.join(root, "b.txt"), "B");
  const sentMessages: SentMessageRecord[] = [];

  const manager = createManager({
    backend: "sdk",
    runnerCwd: root,
    workspaceRoot: root,
    telegram: {
      sendMessage: async (chatId: string | number, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
      },
      sendChatAction: async () => ({}),
      sendDocument: async (
        chatId: string | number,
        document: unknown,
        options?: Record<string, unknown>
      ) => {
        sentMessages.push({ chatId, document, options });
        return { message_id: sentMessages.length };
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    },
    codexClientFactory: createFakeCodexClient([
      {
        events: async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "item-file-1",
              type: "file_change",
              changes: [{ kind: "write", path: "a.txt" }]
            }
          };
          yield {
            type: "item.completed",
            item: {
              id: "item-file-2",
              type: "file_change",
              changes: [{ kind: "write", path: "b.txt" }]
            }
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1
            }
          };
        }
      }
    ])
  });

  await manager.sendPrompt({ chat: { id: 34 } }, "make two files");
  await waitFor(() => !manager.getStatus(34).active);

  const notice = sentMessages.find(
    (entry) =>
      entry.text && /Sending these Telegram attachments/i.test(entry.text)
  );
  assert.ok(notice);
  assert.match(notice.text || "", /a\.txt/);
  assert.match(notice.text || "", /b\.txt/);

  const artifacts = sentMessages.filter((entry) => Boolean(entry.document));
  assert.equal(artifacts.length, 2);
});

test("pty manager falls back to git diff artifacts for sdk sessions", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claws-sdk-git-artifacts-")
  );
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "weather.png"), "png-bytes");
  const sentMessages: SentMessageRecord[] = [];

  const manager = createManager({
    backend: "sdk",
    runnerCwd: root,
    workspaceRoot: root,
    telegram: {
      sendMessage: async () => ({ message_id: 1 }),
      sendChatAction: async () => ({}),
      sendDocument: async () => ({ message_id: 1 }),
      sendPhoto: async (
        chatId: string | number,
        photo: unknown,
        options?: Record<string, unknown>
      ) => {
        sentMessages.push({ chatId, photo, options });
        return { message_id: sentMessages.length };
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    },
    codexClientFactory: createFakeCodexClient([
      {
        events: async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "item-msg",
              type: "agent_message",
              text: "weather chart ready"
            }
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1
            }
          };
        }
      }
    ])
  });

  const originalListChangedFilesFromGit =
    manager.listChangedFilesFromGit.bind(manager);
  let callCount = 0;
  manager.listChangedFilesFromGit = () => {
    callCount += 1;
    if (callCount === 1) {
      return new Set();
    }

    return new Set([path.join(root, "weather.png")]);
  };

  await manager.sendPrompt({ chat: { id: 66 } }, "make a weather png");
  await waitFor(() => !manager.getStatus(66).active);
  manager.listChangedFilesFromGit = originalListChangedFilesFromGit;

  const artifact = sentMessages.find((entry) => Boolean(entry.photo));
  assert.ok(artifact);
  assert.equal(artifact.chatId, "66");
  assert.deepEqual(artifact.options, {
    caption: "Generated file: weather.png"
  });
});

test("pty manager sends generated images back as Telegram photos", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-photo-artifacts-"));
  fs.writeFileSync(path.join(root, "preview.png"), "png-bytes");
  const sentMessages: SentMessageRecord[] = [];

  const manager = createManager({
    backend: "sdk",
    runnerCwd: root,
    workspaceRoot: root,
    telegram: {
      sendMessage: async () => ({ message_id: 1 }),
      sendChatAction: async () => ({}),
      sendDocument: async () => ({ message_id: 1 }),
      sendPhoto: async (
        chatId: string | number,
        photo: unknown,
        options?: Record<string, unknown>
      ) => {
        sentMessages.push({ chatId, photo, options });
        return { message_id: sentMessages.length };
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    },
    codexClientFactory: createFakeCodexClient([
      {
        events: async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "item-photo",
              type: "file_change",
              changes: [{ kind: "write", path: "preview.png" }]
            }
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1
            }
          };
        }
      }
    ])
  });

  await manager.sendPrompt({ chat: { id: 44 } }, "make a preview image");
  await waitFor(() => !manager.getStatus(44).active);

  const photoArtifact = sentMessages.find((entry) => Boolean(entry.photo));
  assert.ok(photoArtifact);
  assert.equal(photoArtifact.chatId, "44");
  assert.deepEqual(photoArtifact.options, {
    caption: "Generated file: preview.png"
  });
});

test("pty manager sends newly changed git files back for cli sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-cli-artifacts-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "before.txt"), "old");

  const sentMessages: SentMessageRecord[] = [];
  const manager = createManager({
    backend: "cli",
    runnerCwd: root,
    workspaceRoot: root,
    telegram: {
      sendMessage: async () => ({ message_id: 1 }),
      sendChatAction: async () => ({}),
      sendDocument: async (
        chatId: string | number,
        document: unknown,
        options?: Record<string, unknown>
      ) => {
        sentMessages.push({ chatId, document, options });
        return { message_id: sentMessages.length };
      },
      editMessageText: async () => ({}),
      deleteMessage: async () => ({})
    }
  });

  const originalListChangedFilesFromGit =
    manager.listChangedFilesFromGit.bind(manager);
  let callCount = 0;
  manager.listChangedFilesFromGit = () => {
    callCount += 1;
    if (callCount === 1) {
      return new Set([path.join(root, "before.txt")]);
    }

    return new Set([
      path.join(root, "before.txt"),
      path.join(root, "after.txt")
    ]);
  };

  fs.writeFileSync(path.join(root, "after.txt"), "new");
  const session = manager.createBaseSession("55", "exec", { workdir: root });
  await manager.finalizeSession(session, 0, null);
  manager.listChangedFilesFromGit = originalListChangedFilesFromGit;

  const artifact = sentMessages.find((entry) => Boolean(entry.document));
  assert.ok(artifact);
  assert.equal(artifact.chatId, "55");
  assert.deepEqual(artifact.options, {
    caption: "Generated file: after.txt"
  });
});
