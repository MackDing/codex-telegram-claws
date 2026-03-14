import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "BOT_TOKEN",
  "ALLOWED_USER_IDS",
  "PROACTIVE_USER_IDS",
  "STATE_FILE",
  "CODEX_BACKEND",
  "CODEX_COMMAND",
  "CODEX_ARGS",
  "CODEX_WORKDIR",
  "CODEX_SDK_CONFIG",
  "CODEX_SDK_SKIP_GIT_REPO_CHECK",
  "CODEX_SDK_SANDBOX_MODE",
  "CODEX_SDK_APPROVAL_POLICY",
  "CODEX_SDK_REASONING_EFFORT",
  "CODEX_SDK_NETWORK_ACCESS_ENABLED",
  "CODEX_SDK_WEB_SEARCH_MODE",
  "CODEX_SDK_ADDITIONAL_DIRECTORIES",
  "WORKSPACE_ROOT",
  "SHELL_ENABLED",
  "SHELL_READ_ONLY",
  "SHELL_ALLOWED_COMMANDS",
  "SHELL_DANGEROUS_COMMANDS",
  "SHELL_TIMEOUT_MS",
  "SHELL_MAX_OUTPUT_CHARS",
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
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function withEnv<T>(overrides: Partial<Record<EnvKey, string>>, fn: () => T): T {
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

function withMutedWarnings<T>(fn: () => T): T {
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

test("loadConfig parses env values into runtime config", () => {
  const stateFile = path.join(
    os.tmpdir(),
    "codex-telegram-claws-runtime-state.json"
  );
  const extraDir = path.join(os.tmpdir(), "codex-telegram-claws-sdk-extra");
  const extraDirTwo = path.join(
    os.tmpdir(),
    "codex-telegram-claws-sdk-extra-two"
  );
  fs.mkdirSync(extraDir, { recursive: true });
  fs.mkdirSync(extraDirTwo, { recursive: true });
  const config = withEnv(
    {
      BOT_TOKEN: "telegram-token",
      ALLOWED_USER_IDS: "1, 2",
      PROACTIVE_USER_IDS: "2",
      STATE_FILE: stateFile,
      CODEX_BACKEND: "sdk",
      CODEX_COMMAND: "codex",
      CODEX_ARGS: '--approval-mode auto "--model gpt-5"',
      CODEX_WORKDIR: ".",
      CODEX_SDK_CONFIG:
        '{"show_raw_agent_reasoning":true,"sandbox_workspace_write":{"network_access":true}}',
      CODEX_SDK_SKIP_GIT_REPO_CHECK: "false",
      CODEX_SDK_SANDBOX_MODE: "workspace-write",
      CODEX_SDK_APPROVAL_POLICY: "on-request",
      CODEX_SDK_REASONING_EFFORT: "high",
      CODEX_SDK_NETWORK_ACCESS_ENABLED: "true",
      CODEX_SDK_WEB_SEARCH_MODE: "live",
      CODEX_SDK_ADDITIONAL_DIRECTORIES: JSON.stringify([extraDir, extraDirTwo]),
      WORKSPACE_ROOT: ".",
      SHELL_ENABLED: "true",
      SHELL_READ_ONLY: "false",
      SHELL_ALLOWED_COMMANDS: '["pwd","git status","npm test"]',
      SHELL_DANGEROUS_COMMANDS: '["git push","git commit"]',
      SHELL_TIMEOUT_MS: "15000",
      SHELL_MAX_OUTPUT_CHARS: "4096",
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
  assert.equal(config.app.stateFile, stateFile);
  assert.deepEqual(config.telegram.allowedUserIds, ["1", "2"]);
  assert.deepEqual(config.telegram.proactiveUserIds, ["2"]);
  assert.equal(config.runner.backend, "sdk");
  assert.equal(config.runner.command, "codex");
  assert.equal(config.workspace.root, process.cwd());
  assert.equal(config.shell.enabled, true);
  assert.equal(config.shell.readOnly, false);
  assert.deepEqual(config.shell.allowedCommands, [
    "pwd",
    "git status",
    "npm test"
  ]);
  assert.deepEqual(config.shell.dangerousCommands, ["git push", "git commit"]);
  assert.equal(config.shell.timeoutMs, 15000);
  assert.equal(config.shell.maxOutputChars, 4096);
  assert.deepEqual(config.runner.args, [
    "--approval-mode",
    "auto",
    "--model gpt-5"
  ]);
  assert.equal(config.runner.throttleMs, 1500);
  assert.equal(config.runner.maxBufferChars, 2048);
  assert.deepEqual(config.runner.sdkConfig, {
    show_raw_agent_reasoning: true,
    sandbox_workspace_write: {
      network_access: true
    }
  });
  assert.equal(config.runner.sdkThreadOptions.skipGitRepoCheck, false);
  assert.equal(config.runner.sdkThreadOptions.sandboxMode, "workspace-write");
  assert.equal(config.runner.sdkThreadOptions.approvalPolicy, "on-request");
  assert.equal(config.runner.sdkThreadOptions.modelReasoningEffort, "high");
  assert.equal(config.runner.sdkThreadOptions.networkAccessEnabled, true);
  assert.equal(config.runner.sdkThreadOptions.webSearchMode, "live");
  assert.deepEqual(config.runner.sdkThreadOptions.additionalDirectories, [
    extraDir,
    extraDirTwo
  ]);
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
        SHELL_ALLOWED_COMMANDS: '["pwd"]',
        GITHUB_DEFAULT_WORKDIR: "/definitely/missing/github-workdir",
        MCP_SERVERS:
          '[{"name":"filesystem","command":"npx","cwd":"/definitely/missing/mcp-cwd"}]'
      },
      () => loadConfig()
    )
  );

  assert.equal(config.workspace.root, cwd);
  assert.equal(config.runner.cwd, cwd);
  assert.equal(config.github.defaultWorkdir, cwd);
  assert.equal(config.mcp.servers[0].cwd, cwd);
});

test("loadConfig requires shell allowlist when safe shell is enabled", () => {
  assert.throws(
    () =>
      withEnv(
        {
          BOT_TOKEN: "telegram-token",
          ALLOWED_USER_IDS: "1",
          SHELL_ENABLED: "true",
          SHELL_ALLOWED_COMMANDS: "[]"
        },
        () => loadConfig()
      ),
    /SHELL_ALLOWED_COMMANDS must contain at least one command prefix/
  );
});
