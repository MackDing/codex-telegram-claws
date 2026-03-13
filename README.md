# Codex Telegram Claws

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-green.svg)](https://nodejs.org/en/download/current)

A Telegram bot that gives you remote access to `@openai/codex` through a PTY-backed Node.js runtime.  
It is strictly inspired by `RichardAtCT/claude-code-telegram`, but this project is implemented for Codex CLI + MCP + Subagent routing.

## What Is This?

This bot connects Telegram to Codex CLI and routes tasks to the right execution surface:

- **Coding tasks** -> Codex CLI in `node-pty` (real TTY, stable interactive behavior)
- **Explicit tool tasks** -> Subagents (`/mcp`, `GitHub Skill`)
- **Proactive automation** -> Cron scheduler for daily summaries and push notifications

Key design goals:

- Keep Codex interactive sessions smooth and stream-safe on Telegram
- Enforce zero-trust access with whitelist-only users
- Avoid duplicate MCP calls by separating Codex MCP vs Bot MCP responsibilities

## Quick Start

### Prerequisites

- Node.js 20+ -- https://nodejs.org/en/download/current
- Codex CLI -- https://github.com/openai/codex
- Telegram Bot Token -- from `@BotFather`

### Install

```bash
git clone https://github.com/MackDing/codex-telegram-claws.git
cd codex-telegram-claws
npm install
```

### Configure

```bash
cp .env.example .env
```

Minimum required:

```bash
BOT_TOKEN=123456789:telegram-token
ALLOWED_USER_IDS=123456789
WORKSPACE_ROOT=.
CODEX_WORKDIR=.
```

Optional safe shell:

```bash
SHELL_ENABLED=true
SHELL_READ_ONLY=true
SHELL_ALLOWED_COMMANDS=["pwd","ls","git status","git diff --stat","npm test","npm run check"]
SHELL_DANGEROUS_COMMANDS=["git add","git commit","git push","rm","mv","cp","npm publish"]
```

### Run

```bash
npm run start
```

Development mode:

```bash
npm run dev
```

Sanity check:

```bash
npm run check
npm test
```

## Architecture

```text
Telegram Message
  -> src/bot/handlers.js
  -> src/orchestrator/router.js
     -> src/runner/ptyManager.js        (coding tasks -> Codex CLI)
     -> src/orchestrator/skills/*.js    (general tasks -> MCP/GitHub subagents)
  -> src/bot/formatter.js
  -> Telegram sendMessage/editMessageText
```

Core modules:

- `src/index.js`: bootstrap and lifecycle
- `src/config.js`: env parsing and validation
- `src/bot/`: auth middleware, formatting, command handlers
- `src/orchestrator/`: routing + MCP client + skills
- `src/runner/ptyManager.js`: Codex PTY process + streaming
- `src/cron/scheduler.js`: proactive scheduled push

## Routing and MCP Boundary

To avoid duplicated context fetch:

- **Coding requests** are sent directly to Codex CLI (Codex can use its own MCP stack)
- **Bot-side MCP** is only used by explicit `/mcp ...` commands

This prevents:

- duplicate queries against the same MCP server
- extra latency/token/tool cost
- context drift from two independent MCP execution surfaces

## Commands

General:

- `/start` - bootstrap message
- `/help` - command summary
- `/status` - show current chat status, active runner mode, workdir, model override, MCP servers
- `/pwd` - show the current project directory for this chat
- `/repo` - list switchable git projects under `WORKSPACE_ROOT`
- `/repo <name>` - switch the current chat to another project
- `/repo <keyword>` - fuzzy match projects; switch if only one match, otherwise list candidates
- `/repo recent` - show recent projects for the current chat
- `/repo -` - switch back to the previous project
- `/new` - close current session and start fresh on the next message
- `/exec <task>` - force a one-off `codex exec`
- `/auto <task>` - force a one-off `codex exec --full-auto`
- `/plan <task>` - ask Codex for a plan only, without direct file modification intent
- `/model [name|reset]` - show or set the model override for the current chat
- `/skill list` - show skill switches for the current chat
- `/skill status` - alias of `/skill list`
- `/skill on <name>` - enable a skill for the current chat
- `/skill off <name>` - disable a skill for the current chat
- `/sh <command>` - run a safe allowlisted Linux command in the current project (disabled by default)
- `/sh --confirm <command>` - confirm a dangerous command when writable mode is enabled
- `/interrupt` - send `Ctrl+C` to current PTY session
- `/stop` - terminate current PTY session
- `/cron_now` - trigger daily summary immediately

MCP skill:

- `/mcp list`
- `/mcp status [server]`
- `/mcp reconnect <server>`
- `/mcp enable <server>`
- `/mcp disable <server>`
- `/mcp tools <server>`
- `/mcp call <server> <tool> {"query":"..."}`

GitHub skill:

- `/gh commit "feat: message"` -> `git add .` + commit + push
- `/gh push` -> push current branch
- `/gh create repo my-new-repo` -> create repo and bind origin
- `/gh run tests` -> launch test job
- `/gh test status <jobId>` -> read test status/output tail

Telegram adaptation notes:

- Plain text messages behave like `codex "task description"`
- `/exec` behaves like `codex exec "task"`
- `/auto` behaves like `codex exec --full-auto "task"`
- `/new` is implemented by the bot and resets the current chat session
- `/status` is implemented by the bot and reports local runtime state
- `/repo` is implemented by the bot and switches the per-chat working directory inside `WORKSPACE_ROOT`
- `/skill` is implemented by the bot and keeps per-chat skill switches in runtime state
- `/sh` is implemented by the bot, never invokes a shell interpreter, and only accepts configured command prefixes
- `/sh` is read-only by default; dangerous prefixes can be configured and require `--confirm` when writable mode is enabled
- `/plan` translates to a planning-only prompt instead of passing a raw `/plan` slash command to Codex

## Streaming and Reasoning Visualization

PTY output is streamed with throttled `editMessageText` updates.

- Throttle: controlled by `STREAM_THROTTLE_MS` (default `1200`)
- Long output: auto-chunked to Telegram-safe message sizes
- MarkdownV2: escaped to avoid parse failures
- Reasoning tags: `<think>...</think>` extracted and rendered as:
  - spoiler (`||...||`, default)
  - quote block (if `REASONING_RENDER_MODE=quote`)
- If `node-pty` cannot spawn on the current host, the runner falls back to `codex exec` for per-request execution

## Event-Driven Automation

`node-cron` is built in for proactive behavior:

- Daily summary schedule: `CRON_DAILY_SUMMARY` (default `0 9 * * *`)
- Target users: `PROACTIVE_USER_IDS`
- Summary includes commit count, changed files, insertions/deletions, and recent commits

Use `/cron_now` for manual trigger during debugging.

## Configuration

Required:

```bash
BOT_TOKEN=...
ALLOWED_USER_IDS=123456789,987654321
WORKSPACE_ROOT=.
CODEX_WORKDIR=.
```

Common options:

```bash
CODEX_COMMAND=codex
CODEX_ARGS=
WORKSPACE_ROOT=/Users/yourname/projects
SHELL_ENABLED=false
SHELL_READ_ONLY=true
SHELL_ALLOWED_COMMANDS=["pwd","ls","git status","git diff --stat","npm test","npm run check"]
SHELL_DANGEROUS_COMMANDS=["git add","git commit","git push","rm","mv","cp","npm publish"]
SHELL_TIMEOUT_MS=20000
SHELL_MAX_OUTPUT_CHARS=12000
STREAM_THROTTLE_MS=1200
STREAM_BUFFER_CHARS=120000
REASONING_RENDER_MODE=spoiler

CRON_DAILY_SUMMARY=0 9 * * *
CRON_TIMEZONE=Asia/Shanghai
PROACTIVE_USER_IDS=123456789
```

MCP:

```bash
MCP_SERVERS=[]
```

GitHub:

```bash
GITHUB_TOKEN=ghp_xxx
GITHUB_DEFAULT_WORKDIR=.
GITHUB_DEFAULT_BRANCH=main
E2E_TEST_COMMAND=npx playwright test --reporter=line
```

## Security Baseline

- Whitelist-only access (`ALLOWED_USER_IDS`) is mandatory
- Do not commit `.env`, tokens, or session artifacts
- Run bot under a restricted OS user in production
- Keep `CODEX_WORKDIR` scoped to a safe workspace root
- Keep `WORKSPACE_ROOT` limited to a parent directory that only contains projects you want the bot to access
- Keep `/sh` disabled unless you need it; when enabled, only expose read-only or narrowly scoped command prefixes
- `/sh` uses `spawn(..., { shell: false })`, rejects pipes/redirection/subshell syntax, and runs inside the current project directory
- Keep `SHELL_READ_ONLY=true` unless you have a strong reason to allow write commands
- If you allow write commands, mark high-risk prefixes in `SHELL_DANGEROUS_COMMANDS` and require `/sh --confirm ...`
- Prefer least-privilege GitHub PAT

## Should You Enable `/sh`?

Usually not for general users. Codex itself can run commands as part of a coding task, so `/sh` is not required for normal code-edit workflows.

It is useful when you need deterministic operator actions from Telegram, such as:

- `pwd`
- `git status`
- `git diff --stat`
- `npm test`

Treat it as an admin-only ops channel, not a general-purpose remote shell.

## MCP and Skill Control Plane

Telegram can manage runtime usage of Bot-side MCP and skills, but not install arbitrary new servers from chat.

- MCP servers are process-level runtime resources: list, inspect, reconnect, enable, disable
- Skills are chat-level routing switches: each chat can enable or disable `github` and `mcp` independently
- Codex's own MCP remains separate and is not managed through these bot commands

## Troubleshooting

- **Bot not responding**: verify `BOT_TOKEN` and `ALLOWED_USER_IDS`
- **Codex not producing output**: verify `CODEX_COMMAND` and `CODEX_WORKDIR`
- **Markdown parse errors**: reduce output size/context; check special characters in tool output
- **MCP failures**: run `/mcp tools <server>` first to validate server availability
- **GitHub API failures**: verify `GITHUB_TOKEN` scope (`repo`) and account permissions
- **Duplicate MCP suspicion**: ensure coding tasks are routed directly to Codex, and bot MCP is used only for `/mcp`
- **`posix_spawnp failed`**: this means PTY spawn is blocked on the host; the runner will fall back to `codex exec`

## Reference

- Inspired by: https://github.com/RichardAtCT/claude-code-telegram
- This implementation: Codex-first Node.js stack (`telegraf`, `node-pty`, `node-cron`, MCP SDK)
