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
STATE_FILE=.codex-telegram-claws-state.json
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

Validation:

```bash
npm run check
npm run lint
npm run format:check
npm test
npm run healthcheck
```

## Development Commands

- `npm run start` - start the bot
- `npm run dev` - watch mode for local development
- `npm run check` - syntax validation
- `npm run lint` - ESLint for source, tests, scripts, and local JS/CJS config files
- `npm run lint:fix` - apply safe lint fixes
- `npm run format` - format repository files with Prettier
- `npm run format:check` - verify formatting
- `npm test` - run the full test suite
- `npm run healthcheck` - static runtime readiness check
- `npm run healthcheck:strict` - stricter production-oriented health check
- `npm run telegram:smoke` - live Telegram API smoke test when a real bot token is available

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

Enterprise target architecture: [docs/enterprise-architecture.md](/Users/ding/Documents/Code/Github/codex-telegram-claws/docs/enterprise-architecture.md)

## Routing and MCP Boundary

To avoid duplicated context fetch:

- **Coding requests** are sent directly to Codex CLI (Codex can use its own MCP stack)
- **Bot-side MCP** is only used by explicit `/mcp ...` commands

This prevents:

- duplicate queries against the same MCP server
- extra latency/token/tool cost
- context drift from two independent MCP execution surfaces

## Subagents

In this repository, "subagent" means a dedicated skill executor behind the router, not a second free-form Codex session.

Current subagents:

- `github` skill - local git actions, repo creation through GitHub API, and test job tracking
- `mcp` skill - explicit MCP server inspection, enable/disable, tool listing, and tool calls

How they are triggered:

- Explicit commands always go straight to the matching subagent:
  - `/gh ...` -> GitHub skill
  - `/mcp ...` -> MCP skill
- Plain text may also route to a subagent when the router sees a supported GitHub-style request such as `git push`, `commit`, or `run test`
- Everything else falls back to Codex CLI

Where this happens:

- Router decision order: [router.js](/Users/ding/Documents/Code/Github/codex-telegram-claws/src/orchestrator/router.js)
- Skill toggles per chat: [skillRegistry.js](/Users/ding/Documents/Code/Github/codex-telegram-claws/src/orchestrator/skillRegistry.js)
- Telegram command entrypoints: [handlers.js](/Users/ding/Documents/Code/Github/codex-telegram-claws/src/bot/handlers.js)

Operationally, subagents are the bot's control plane. Codex remains the coding execution plane.

## Commands

General:

- `/start` - bootstrap message
- `/help` - command summary
- `/status` - show current chat status, active runner mode, workdir, model override, MCP servers
- `/pwd` - show the current project directory for this chat
- `/repo` - list switchable git projects under `WORKSPACE_ROOT`
- `/repo <name>` - switch the current chat to another project
- `/repo <keyword>` - fuzzy match projects; switch if only one match, otherwise list candidates
- `/repo <typo>` - suggests the closest project name when there is no direct match
- `/repo recent` - show recent projects for the current chat
- `/repo -` - switch back to the previous project
- `/new` - clear the saved Codex conversation for the current project and start fresh on the next message
- `/exec <task>` - force a one-off `codex exec`
- `/auto <task>` - force a one-off `codex exec --full-auto`
- `/plan <task>` - ask Codex for a plan only, without direct file modification intent
- `/model [name|reset]` - show or set the model override for the current chat
- `/language [en|zh|zh-HK]` - show or set the system language for the current chat
- `/verbose [on|off]` - show or toggle system notices for the current chat
- `/skill list` - show skill switches for the current chat
- `/skill status` - alias of `/skill list`
- `/skill on <name>` - enable a skill for the current chat
- `/skill off <name>` - disable a skill for the current chat
- `/sh <command>` - run a safe allowlisted Linux command in the current project (disabled by default)
- `/sh --confirm <command>` - confirm a dangerous command when writable mode is enabled
- `/restart` - restart the bot process explicitly from Telegram
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
- `/new` only clears the current project's saved Codex conversation slot
- `/status` is implemented by the bot and reports local runtime state
- `/repo` is implemented by the bot and switches the per-chat working directory inside `WORKSPACE_ROOT`
- `/skill` is implemented by the bot and keeps per-chat skill switches in runtime state
- `/sh` is implemented by the bot, never invokes a shell interpreter, and only accepts configured command prefixes
- `/sh` is read-only by default; dangerous prefixes can be configured and require `--confirm` when writable mode is enabled
- `/plan` translates to a planning-only prompt instead of passing a raw `/plan` slash command to Codex
- The default system language is English; use `/language zh` or `/language zh-HK` for localized bot responses
- `/verbose off` keeps Telegram output quiet by hiding fallback, startup, and session-exit notices for the current chat

## Streaming and Reasoning Visualization

PTY output is streamed with throttled `editMessageText` updates.

- Throttle: controlled by `STREAM_THROTTLE_MS` (default `1200`)
- Long output: auto-chunked to Telegram-safe message sizes
- MarkdownV2: escaped to avoid parse failures
- Reasoning tags: `<think>...</think>` extracted and rendered as:
  - spoiler (`||...||`, default)
  - quote block (if `REASONING_RENDER_MODE=quote`)
- If `node-pty` cannot spawn on the current host, the runner falls back to `codex exec` for per-request execution
- In `codex exec` fallback mode, Telegram output is cleaned to hide the Codex banner, raw tool trace, `mcp startup`, and duplicate `tokens used` footer
- On macOS, startup now auto-repairs `node-pty` helper execute permissions before the first PTY session

## Project-Scoped Conversation State

Conversation state is now tracked per `chat + project`, not just per chat.

- When you switch with `/repo <name>`, the bot keeps that project's last Codex session id in runtime state
- When you switch back to the same project later, the next plain-text task resumes that project's Codex conversation
- `/new` clears only the current project's saved conversation slot; other projects in the same Telegram chat are untouched
- `/exec`, `/auto`, and `/plan` stay one-off by design and do not replace the saved project conversation
- On hosts where PTY is unavailable, project restore still works through `codex exec resume`

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
STATE_FILE=.codex-telegram-claws-state.json
WORKSPACE_ROOT=.
CODEX_WORKDIR=.
```

Common options:

```bash
CODEX_COMMAND=codex
CODEX_ARGS=
WORKSPACE_ROOT=/Users/yourname/projects
STATE_FILE=/path/to/codex-telegram-claws-state.json
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

## CI And Release Automation

GitHub Actions now includes:

- `CI` workflow on push and pull request
- `Telegram Smoke` manual workflow for live bot-token validation when repository secrets are configured
- `Release` workflow on `v*` tags, which reruns validation and publishes a GitHub Release

Repository secrets for live smoke checks:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_EXPECTED_USERNAME` (optional)
- `TELEGRAM_SMOKE_CHAT_ID` (optional)

Recommended local release gate:

```bash
npm run ci
node scripts/healthcheck.js --strict --telegram-live
```

Release references:

- [operations.md](/Users/ding/Documents/Code/Github/codex-telegram-claws/docs/operations.md)
- [release.md](/Users/ding/Documents/Code/Github/codex-telegram-claws/docs/release.md)
- [ecosystem.config.cjs](/Users/ding/Documents/Code/Github/codex-telegram-claws/ecosystem.config.cjs)

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

## Operations

The recommended production supervisor is PM2.

Basic flow:

```bash
pm2 start ecosystem.config.cjs
pm2 status codex-telegram-claws
pm2 logs codex-telegram-claws
pm2 restart codex-telegram-claws
```

Run exactly one polling process per bot token.

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
- Runtime state is persisted to `STATE_FILE`, so `/mcp enable|disable`, `/skill on|off`, `/language`, `/verbose`, and per-project Codex conversation slots survive bot restarts

## Troubleshooting

- **Bot not responding**: verify `BOT_TOKEN` and `ALLOWED_USER_IDS`
- **Codex not producing output**: verify `CODEX_COMMAND` and `CODEX_WORKDIR`
- **Markdown parse errors**: reduce output size/context; check special characters in tool output
- **MCP failures**: run `/mcp tools <server>` first to validate server availability
- **GitHub API failures**: verify `GITHUB_TOKEN` scope (`repo`) and account permissions
- **Duplicate MCP suspicion**: ensure coding tasks are routed directly to Codex, and bot MCP is used only for `/mcp`
- **`posix_spawnp failed`**: this usually means the `node-pty` helper lost execute permissions; startup now auto-repairs it, and `npm run healthcheck` reports the result

## Reference

- Inspired by: https://github.com/RichardAtCT/claude-code-telegram
- This implementation: Codex-first Node.js stack (`telegraf`, `node-pty`, `node-cron`, MCP SDK)
