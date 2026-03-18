import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { registerHandlers } from "../src/bot/handlers.js";

type Handler = (ctx: TestContext) => Promise<void> | void;

interface ReplyRecord {
  text: string;
  options?: Record<string, unknown>;
}

interface TestContext {
  chat: {
    id: number;
  };
  from: {
    id: number;
  };
  telegram?: {
    getFileLink?: (fileId: string) => Promise<string>;
  };
  message: Record<string, unknown> & {
    text?: string;
    caption?: string;
  };
  callbackQuery?: {
    data?: string;
  };
  replies: ReplyRecord[];
  reply: (text: string, options?: Record<string, unknown>) => Promise<void>;
  answerCbQuery: (text?: string) => Promise<void>;
}

class FakeBot {
  readonly commands = new Map<string, Handler>();
  readonly events = new Map<string, Handler>();
  startHandler: Handler | null = null;

  start(handler: Handler): void {
    this.startHandler = handler;
  }

  command(name: string, handler: Handler): void {
    this.commands.set(name, handler);
  }

  on(event: string, handler: Handler): void {
    this.events.set(event, handler);
  }
}

function createContext(text: string, chatId = 1): TestContext {
  const replies: ReplyRecord[] = [];
  return {
    chat: {
      id: chatId
    },
    from: {
      id: chatId
    },
    telegram: {},
    message: {
      text
    },
    replies,
    reply: async (replyText: string, options?: Record<string, unknown>) => {
      replies.push({
        text: replyText,
        options
      });
    },
    answerCbQuery: async () => {}
  };
}

function createMediaContext(
  message: TestContext["message"],
  chatId = 1
): TestContext {
  const ctx = createContext("", chatId);
  ctx.message = message;
  return ctx;
}

function createDependencies(
  overrides: {
    sendPrompt?: (...args: any[]) => Promise<unknown>;
    continuePendingPrompt?: (...args: any[]) => Promise<unknown>;
    routeMessage?: (text: string) => Promise<unknown>;
    githubExecute?: () => Promise<unknown>;
    getStatus?: () => Record<string, unknown>;
    switchWorkdir?: (chatId: string | number, target: string) => unknown;
    devStart?: () => Promise<unknown>;
    devStatus?: () => Record<string, unknown>;
    devStop?: () => boolean;
    devLogs?: () => string;
    devUrl?: () => string | null;
  } = {}
) {
  const bot = new FakeBot();
  const ptyManager = {
    getLanguage: () => "en",
    sendPrompt:
      overrides.sendPrompt ||
      (async () => ({
        started: true,
        mode: "sdk"
      })),
    continuePendingPrompt:
      overrides.continuePendingPrompt ||
      (async () => ({
        started: true,
        mode: "sdk"
      })),
    getStatus:
      overrides.getStatus ||
      (() => ({
        backend: "sdk",
        active: false,
        activeMode: null,
        lastMode: null,
        lastExitCode: null,
        lastExitSignal: null,
        projectSessionId: null,
        preferredModel: null,
        language: "en",
        verboseOutput: false,
        ptySupported: null,
        workdir: process.cwd(),
        relativeWorkdir: ".",
        workspaceRoot: process.cwd(),
        command: "codex",
        mcpServers: [],
        workflowSystem: "superpowers",
        workflowPhase: "none"
      })),
    getRecentProjects: () => [],
    switchWorkdir:
      overrides.switchWorkdir ||
      (() => ({
        workdir: process.cwd(),
        relativePath: "."
      }))
  };

  registerHandlers({
    bot,
    router: {
      routeMessage:
        overrides.routeMessage ||
        (async (text: string) => ({
          target: "pty" as const,
          prompt: text
        }))
    } as any,
    ptyManager: ptyManager as any,
    shellManager: {
      isEnabled: () => false,
      isReadOnly: () => true,
      getAllowedCommands: () => [],
      inspectCommand: () => {
        throw new Error("not used");
      },
      execute: async () => ({ started: false, reason: "busy" })
    } as any,
    devServerManager: {
      start:
        overrides.devStart ||
        (async () => ({
          started: true,
          scriptName: "dev",
          packageManager: "npm",
          command: "npm run dev"
        })),
      getStatus:
        overrides.devStatus ||
        (() => ({
          running: false,
          status: "stopped",
          workdir: process.cwd(),
          startedByChatId: null,
          command: null,
          packageManager: null,
          scriptName: null,
          pid: null,
          startedAt: null,
          exitedAt: null,
          exitCode: null,
          signal: null,
          detectedUrl: null
        })),
      stop: overrides.devStop || (() => false),
      getLogs: overrides.devLogs || (() => "(no logs yet)"),
      getUrl: overrides.devUrl || (() => null)
    } as any,
    skills: {
      github: {
        execute: overrides.githubExecute || (async () => ({ text: "unused" })),
        getTestStatus: async () => null
      },
      mcp: {
        execute: async () => ({ text: "unused" }),
        mcpClient: {
          listServers: () => []
        }
      }
    } as any,
    skillRegistry: {
      list: () => [],
      isEnabled: () => true,
      enable: () => ({
        changed: true,
        skills: []
      }),
      disable: () => ({
        changed: true,
        skills: []
      })
    } as any,
    scheduler: {
      triggerDailySummaryNow: async () => {}
    } as any
  });

  return { bot };
}

test("dev start reports the selected frontend script", async () => {
  const { bot } = createDependencies({
    devStart: async () => ({
      started: true,
      scriptName: "start",
      packageManager: "npm",
      command: "npm run start"
    })
  });
  const ctx = createContext("/dev start");
  const handler = bot.commands.get("dev");

  if (!handler) {
    throw new Error("Expected /dev handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /npm run start/i);
  assert.match(ctx.replies[0].text, /dev server|frontend/i);
});

test("dev status, url, and logs expose repo-scoped frontend runtime details", async () => {
  const { bot } = createDependencies({
    devStatus: () => ({
      running: true,
      status: "running",
      workdir: process.cwd(),
      startedByChatId: "1",
      command: "npm run dev",
      packageManager: "npm",
      scriptName: "dev",
      pid: 123,
      startedAt: "2026-03-15T04:00:00.000Z",
      exitedAt: null,
      exitCode: null,
      signal: null,
      detectedUrl: "http://127.0.0.1:5173/"
    }),
    devLogs: () => "Local: http://127.0.0.1:5173/",
    devUrl: () => "http://127.0.0.1:5173/"
  });
  const statusHandler = bot.commands.get("dev");

  if (!statusHandler) {
    throw new Error("Expected /dev handler to be registered");
  }

  const statusCtx = createContext("/dev status");
  await statusHandler(statusCtx);
  assert.equal(statusCtx.replies.length > 0, true);
  assert.match(statusCtx.replies[0].text, /running/i);
  assert.match(statusCtx.replies[0].text, /npm run dev/i);

  const urlCtx = createContext("/dev url");
  await statusHandler(urlCtx);
  assert.match(urlCtx.replies[0].text, /5173/);

  const logsCtx = createContext("/dev logs");
  await statusHandler(logsCtx);
  assert.match(logsCtx.replies[0].text, /Local:/);
});

test("status command includes the internal superpowers workflow phase", async () => {
  const { bot } = createDependencies({
    getStatus: () => ({
      backend: "sdk",
      active: false,
      activeMode: null,
      lastMode: "sdk",
      lastExitCode: 0,
      lastExitSignal: null,
      projectSessionId: "thread-123",
      preferredModel: null,
      language: "en",
      verboseOutput: true,
      ptySupported: null,
      workdir: process.cwd(),
      relativeWorkdir: ".",
      workspaceRoot: process.cwd(),
      command: "codex",
      mcpServers: [],
      workflowSystem: "superpowers",
      workflowPhase: "brainstorming"
    })
  });
  const ctx = createContext("/status");
  const handler = bot.commands.get("status");

  if (!handler) {
    throw new Error("Expected /status handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /workflow system: superpowers/i);
  assert.match(ctx.replies[0].text, /workflow phase: brainstorming/i);
});

test("skill list explains that superpowers is internal and not toggleable", async () => {
  const { bot } = createDependencies();
  const ctx = createContext("/skill");
  const handler = bot.commands.get("skill");

  if (!handler) {
    throw new Error("Expected /skill handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /internal workflow: superpowers/i);
  assert.match(ctx.replies[0].text, /not toggleable/i);
});

test("text handler warns before starting a second codex run in the same workdir", async () => {
  const { bot } = createDependencies({
    sendPrompt: async () => ({
      started: false,
      reason: "workspace_busy",
      activeMode: "sdk",
      blockingChatId: "2",
      relativeWorkdir: "."
    })
  });
  const ctx = createContext("please fix the repo");
  const textHandler = bot.events.get("text");

  if (!textHandler) {
    throw new Error("Expected text handler to be registered");
  }

  await textHandler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /\/continue/);
  assert.match(ctx.replies[0].text, /same workdir|same project|another chat/i);
});

test("continue command replays a blocked request once", async () => {
  const { bot } = createDependencies({
    continuePendingPrompt: async () => ({
      started: true,
      mode: "sdk"
    })
  });
  const ctx = createContext("/continue");
  const handler = bot.commands.get("continue");

  if (!handler) {
    throw new Error("Expected /continue handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /continu|replay/i);
});

test("continue command reports when no blocked request is pending", async () => {
  const { bot } = createDependencies({
    continuePendingPrompt: async () => ({
      started: false,
      reason: "no_pending_prompt"
    })
  });
  const ctx = createContext("/continue");
  const handler = bot.commands.get("continue");

  if (!handler) {
    throw new Error("Expected /continue handler to be registered");
  }

  await handler(ctx);

  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /no blocked|nothing pending/i);
});

test("text handler shows guidance when plain-text github write actions are blocked", async () => {
  const switched: Array<{ chatId: string | number; target: string }> = [];
  const { bot } = createDependencies({
    routeMessage: async (text: string) => ({
      target: "skill" as const,
      skill: "github" as const,
      payload: text
    }),
    githubExecute: async () => ({
      text: "GitHub write actions require explicit /gh commands. Use /gh create repo five-in-a-row."
    }),
    switchWorkdir: (chatId, target) => {
      switched.push({ chatId, target });
      return {
        workdir: `/tmp/${target}`,
        relativePath: target
      };
    }
  });
  const ctx = createContext("create repo five-in-a-row");
  const textHandler = bot.events.get("text");

  if (!textHandler) {
    throw new Error("Expected text handler to be registered");
  }

  await textHandler(ctx);

  assert.deepEqual(switched, []);
  assert.equal(ctx.replies.length > 0, true);
  assert.match(ctx.replies[0].text, /explicit/i);
  assert.match(ctx.replies[0].text, /\/gh create repo/i);
});

test("photo messages are converted into Codex prompts with caption and file link", async () => {
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  const { bot } = createDependencies({
    sendPrompt: async (_ctx: unknown, prompt: string) => {
      prompts.push(prompt);
      return {
        started: true,
        mode: "sdk"
      };
    }
  });
  const ctx = createMediaContext({
    caption: "帮我看看这张图里有什么问题",
    photo: [
      {
        file_id: "photo-small",
        width: 90,
        height: 90,
        file_size: 1000
      },
      {
        file_id: "photo-large",
        width: 1280,
        height: 720,
        file_size: 245760
      }
    ]
  });
  ctx.telegram = {
    getFileLink: async (fileId: string) =>
      `https://example.test/files/${fileId}.jpg`
  };
  const photoHandler = bot.events.get("photo");

  if (!photoHandler) {
    throw new Error("Expected photo handler to be registered");
  }

  globalThis.fetch = async () =>
    new Response(Buffer.from("fake image bytes"), {
      status: 200,
      headers: {
        "content-length": "16",
        "content-type": "image/jpeg"
      }
    });

  try {
    await photoHandler(ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /attachment type: photo/i);
  assert.match(prompts[0], /1280x720/);
  assert.match(prompts[0], /telegram file id: photo-large/);
  assert.match(prompts[0], /https:\/\/example\.test\/files\/photo-large\.jpg/);
  assert.match(
    prompts[0],
    /cached local path: \/tmp\/codexclaw-telegram-attachments\//
  );
  assert.match(prompts[0], /download status: cached/);
  assert.match(prompts[0], /帮我看看这张图里有什么问题/);
});

test("document messages include inline text when the attachment is readable text", async () => {
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  const { bot } = createDependencies({
    sendPrompt: async (_ctx: unknown, prompt: string) => {
      prompts.push(prompt);
      return {
        started: true,
        mode: "sdk"
      };
    }
  });
  const ctx = createMediaContext({
    document: {
      file_id: "doc-1",
      file_name: "error.log",
      mime_type: "text/plain",
      file_size: 4096
    }
  });
  ctx.telegram = {
    getFileLink: async (fileId: string) =>
      `https://example.test/files/${fileId}.txt`
  };
  const documentHandler = bot.events.get("document");

  if (!documentHandler) {
    throw new Error("Expected document handler to be registered");
  }

  globalThis.fetch = async () =>
    new Response(Buffer.from("line one\nline two\nline three\n"), {
      status: 200,
      headers: {
        "content-length": "28",
        "content-type": "text/plain"
      }
    });

  try {
    await documentHandler(ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /attachment type: document/i);
  assert.match(prompts[0], /file name: error\.log/i);
  assert.match(prompts[0], /mime type: text\/plain/i);
  assert.match(prompts[0], /inline attachment text:/i);
  assert.match(prompts[0], /line one/);
  assert.match(prompts[0], /caption: \(none\)/i);
});

test("document messages fall back cleanly when attachment download fails", async () => {
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  const { bot } = createDependencies({
    sendPrompt: async (_ctx: unknown, prompt: string) => {
      prompts.push(prompt);
      return {
        started: true,
        mode: "sdk"
      };
    }
  });
  const ctx = createMediaContext({
    document: {
      file_id: "doc-2",
      file_name: "broken.log",
      mime_type: "text/plain",
      file_size: 42
    }
  });
  ctx.telegram = {
    getFileLink: async (fileId: string) =>
      `https://example.test/files/${fileId}.txt`
  };
  const documentHandler = bot.events.get("document");

  if (!documentHandler) {
    throw new Error("Expected document handler to be registered");
  }

  globalThis.fetch = async () =>
    new Response("denied", {
      status: 403
    });

  try {
    await documentHandler(ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /cached local path: unavailable/i);
  assert.match(prompts[0], /download status: not cached/i);
});

test("cached text attachments are actually written to disk", async () => {
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  const { bot } = createDependencies({
    sendPrompt: async (_ctx: unknown, prompt: string) => {
      prompts.push(prompt);
      return {
        started: true,
        mode: "sdk"
      };
    }
  });
  const ctx = createMediaContext({
    document: {
      file_id: "doc-cache",
      file_name: "sample.txt",
      mime_type: "text/plain",
      file_size: 12
    }
  });
  ctx.telegram = {
    getFileLink: async () => "https://example.test/files/sample.txt"
  };
  const documentHandler = bot.events.get("document");

  if (!documentHandler) {
    throw new Error("Expected document handler to be registered");
  }

  globalThis.fetch = async () =>
    new Response(Buffer.from("cached hello"), {
      status: 200,
      headers: {
        "content-length": "12",
        "content-type": "text/plain"
      }
    });

  try {
    await documentHandler(ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const cachedPathMatch = prompts[0]?.match(
    /cached local path: (\/tmp\/codexclaw-telegram-attachments\/[^\n]+)/
  );
  assert.ok(cachedPathMatch);
  const cachedContent = await fs.readFile(cachedPathMatch[1], "utf8");
  assert.equal(cachedContent, "cached hello");
});
