import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseCsv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(value) {
  if (!value || !value.trim()) return [];
  const parts = value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ""));
}

function parseJson(value, fallback) {
  if (!value || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in environment variable: ${error.message}`);
  }
}

function resolveDirectory(value, name, fallback = process.cwd()) {
  const resolvedFallback = path.resolve(fallback);
  const candidate = path.resolve(value || resolvedFallback);

  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    return candidate;
  }

  if (value && value.trim()) {
    console.warn(`[config] ${name} does not exist: ${candidate}. Falling back to ${resolvedFallback}`);
  }

  return resolvedFallback;
}

function normalizeMcpServer(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.name || !raw.command) {
    throw new Error(`Invalid MCP server config at index ${index}: "name" and "command" are required.`);
  }

  return {
    name: String(raw.name),
    command: String(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    cwd: resolveDirectory(raw.cwd ? String(raw.cwd) : process.cwd(), `MCP_SERVERS[${index}].cwd`),
    env: raw.env && typeof raw.env === "object" ? raw.env : {}
  };
}

export function loadConfig() {
  const allowedUserIds = parseCsv(process.env.ALLOWED_USER_IDS);
  if (!allowedUserIds.length) {
    throw new Error("ALLOWED_USER_IDS must contain at least one Telegram user id.");
  }

  const proactiveUserIds = parseCsv(process.env.PROACTIVE_USER_IDS || process.env.ALLOWED_USER_IDS);
  const rawMcpServers = parseJson(process.env.MCP_SERVERS, []);
  const mcpServers = Array.isArray(rawMcpServers)
    ? rawMcpServers.map((server, index) => normalizeMcpServer(server, index)).filter(Boolean)
    : [];
  const runnerCwd = resolveDirectory(process.env.CODEX_WORKDIR, "CODEX_WORKDIR");
  const workspaceRoot = resolveDirectory(
    process.env.WORKSPACE_ROOT,
    "WORKSPACE_ROOT",
    runnerCwd
  );
  const githubDefaultWorkdir = resolveDirectory(process.env.GITHUB_DEFAULT_WORKDIR, "GITHUB_DEFAULT_WORKDIR");

  return {
    app: {
      name: "codex-telegram-claws"
    },
    workspace: {
      root: workspaceRoot
    },
    telegram: {
      botToken: required("BOT_TOKEN"),
      allowedUserIds,
      proactiveUserIds
    },
    runner: {
      command: process.env.CODEX_COMMAND?.trim() || "codex",
      args: parseArgs(process.env.CODEX_ARGS || ""),
      cwd: runnerCwd,
      throttleMs: parseNumber(process.env.STREAM_THROTTLE_MS, 1200),
      maxBufferChars: parseNumber(process.env.STREAM_BUFFER_CHARS, 120000),
      telegramChunkSize: 3900
    },
    reasoning: {
      mode: process.env.REASONING_RENDER_MODE === "quote" ? "quote" : "spoiler"
    },
    cron: {
      dailySummary: process.env.CRON_DAILY_SUMMARY?.trim() || "0 9 * * *",
      timezone: process.env.CRON_TIMEZONE?.trim() || "Asia/Shanghai"
    },
    mcp: {
      servers: mcpServers
    },
    github: {
      token: process.env.GITHUB_TOKEN?.trim() || "",
      defaultWorkdir: githubDefaultWorkdir,
      defaultBranch: process.env.GITHUB_DEFAULT_BRANCH?.trim() || "main",
      e2eCommand: process.env.E2E_TEST_COMMAND?.trim() || "npx playwright test --reporter=line"
    }
  };
}
