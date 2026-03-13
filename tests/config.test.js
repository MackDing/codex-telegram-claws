import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "BOT_TOKEN",
  "ALLOWED_USER_IDS",
  "PROACTIVE_USER_IDS",
  "CODEX_COMMAND",
  "CODEX_ARGS",
  "CODEX_WORKDIR",
  "WORKSPACE_ROOT",
  "STREAM_THROTTLE_MS",
  "STREAM_BUFFER_CHARS",
  "REASONING_RENDER_MODE",
  "CRON_DAILY_SUMMARY",
  "CRON_TIMEZONE",
  "MCP_SERVERS",
  "GITHUB_TOKEN",
  "GITHUB_DEFAULT_WORKDIR",
  "GITHUB_DEFAULT_BRANCH",
  "E2E_TEST_COMMAND"
];

function withEnv(overrides, fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  Object.assign(process.env, overrides);

  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withMutedWarnings(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

test("loadConfig parses env values into runtime config", () => {
  const config = withEnv(
    {
      BOT_TOKEN: "telegram-token",
      ALLOWED_USER_IDS: "1, 2",
      PROACTIVE_USER_IDS: "2",
      CODEX_COMMAND: "codex",
      CODEX_ARGS: "--approval-mode auto \"--model gpt-5\"",
      CODEX_WORKDIR: ".",
      WORKSPACE_ROOT: ".",
      STREAM_THROTTLE_MS: "1500",
      STREAM_BUFFER_CHARS: "2048",
      REASONING_RENDER_MODE: "quote",
      CRON_DAILY_SUMMARY: "0 8 * * *",
      CRON_TIMEZONE: "Asia/Singapore",
      MCP_SERVERS:
        '[{"name":"filesystem","command":"npx","args":["-y","server-filesystem","/tmp"],"cwd":"."}]',
      GITHUB_TOKEN: "ghp_test",
      GITHUB_DEFAULT_WORKDIR: ".",
      GITHUB_DEFAULT_BRANCH: "develop",
      E2E_TEST_COMMAND: "npm test"
    },
    () => loadConfig()
  );

  assert.equal(config.telegram.botToken, "telegram-token");
  assert.deepEqual(config.telegram.allowedUserIds, ["1", "2"]);
  assert.deepEqual(config.telegram.proactiveUserIds, ["2"]);
  assert.equal(config.runner.command, "codex");
  assert.equal(config.workspace.root, process.cwd());
  assert.deepEqual(config.runner.args, ["--approval-mode", "auto", "--model gpt-5"]);
  assert.equal(config.runner.throttleMs, 1500);
  assert.equal(config.runner.maxBufferChars, 2048);
  assert.equal(config.reasoning.mode, "quote");
  assert.equal(config.cron.dailySummary, "0 8 * * *");
  assert.equal(config.cron.timezone, "Asia/Singapore");
  assert.equal(config.mcp.servers.length, 1);
  assert.equal(config.mcp.servers[0].name, "filesystem");
  assert.equal(config.github.token, "ghp_test");
  assert.equal(config.github.defaultBranch, "develop");
  assert.equal(config.github.e2eCommand, "npm test");
});

test("loadConfig requires at least one allowed user", () => {
  assert.throws(
    () =>
      withEnv(
        {
          BOT_TOKEN: "telegram-token",
          ALLOWED_USER_IDS: ""
        },
        () => loadConfig()
      ),
    /ALLOWED_USER_IDS must contain at least one Telegram user id/
  );
});

test("loadConfig falls back to the current working directory when configured paths do not exist", () => {
  const cwd = process.cwd();
  const config = withMutedWarnings(() =>
    withEnv(
      {
        BOT_TOKEN: "telegram-token",
        ALLOWED_USER_IDS: "1",
        WORKSPACE_ROOT: "/definitely/missing/workspace-root",
        CODEX_WORKDIR: "/definitely/missing/codex-workdir",
        GITHUB_DEFAULT_WORKDIR: "/definitely/missing/github-workdir",
        MCP_SERVERS: '[{"name":"filesystem","command":"npx","cwd":"/definitely/missing/mcp-cwd"}]'
      },
      () => loadConfig()
    )
  );

  assert.equal(config.workspace.root, cwd);
  assert.equal(config.runner.cwd, cwd);
  assert.equal(config.github.defaultWorkdir, cwd);
  assert.equal(config.mcp.servers[0].cwd, cwd);
});
