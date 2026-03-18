# CodexClaw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-green.svg)](https://nodejs.org/en/download/current)

A Telegram bot that gives you remote access to `@openai/codex` through a Node.js runtime with two Codex backends: the Codex SDK and the legacy CLI/PTy path.  
It is strictly inspired by `RichardAtCT/claude-code-telegram`, but this project is implemented for CodeX SDK/CLI + MCP + Subagent routing.

## Use This Like A Skill

### What It Does

- installs a Telegram-facing Codex runtime
- keeps Codex live sessions scoped to `chat + repo`
- manages bot-side MCP and GitHub subagents
- exposes repo switching, status, and minimal frontend dev-server control from Telegram

### Install

```bash
git clone https://github.com/MackDing/CodexClaw.git
cd CodexClaw
npm install
cp .env.example .env
```

### Configure The Minimum

```bash
BOT_TOKEN=123456789:telegram-token
ALLOWED_USER_IDS=123456789
STATE_FILE=.codex-telegram-claws-state.json
WORKSPACE_ROOT=.
CODEX_WORKDIR=.
CODEX_BACKEND=sdk
```

### Start The Skill

```bash
npm run start
```

### Telegram Quick Use

```text
/status
/repo
/skill
/dev status
/gh create repo my-new-app
```

For agent-oriented setup, see [SKILL.md](/Users/ding/Documents/Code/Github/CodexClaw/SKILL.md).

## What Is This?

This bot connects Telegram to Codex and routes tasks to the right execution surface:

- **Coding tasks** -> Codex SDK threads or Codex CLI/PTy sessions
- **Explicit tool tasks** -> Subagents (`/mcp`, `GitHub Skill`)
- **Proactive automation** -> Cron scheduler for daily summaries and push notifications

Key design goals:

- Keep Codex interactive sessions smooth and stream-safe on Telegram
- Enforce zero-trust access with whitelist-only users
- Avoid duplicate MCP calls by separating Codex MCP vs Bot MCP responsibilities
- Prefer the SDK backend for new installs, while keeping the CLI backend as a fallback

## Quick Start

### Prerequisites

- Node.js 20+ -- https://nodejs.org/en/download/current
- Codex CLI -- https://github.com/openai/codex
- Telegram Bot Token -- from `@BotFather`

## Screenshot

### Install

```bash
git clone https://github.com/MackDing/CodexClaw.git
cd CodexClaw
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
CODEX_BACKEND=sdk
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
npm run healthcheck:live
```

For live checks, configure your own local `.env` values after startup and keep the output local.

- do not commit or paste live output containing bot usernames, chat IDs, thread IDs, or other environment-specific identifiers
- use your own `BOT_TOKEN`, `ALLOWED_USER_IDS`, and Codex credentials locally
- for GitHub Actions, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_EXPECTED_USERNAME`, and `TELEGRAM_SMOKE_CHAT_ID` in repository secrets instead of hardcoding them

## Development Commands

- `npm run start` - start the bot
- `npm run dev` - watch mode for local development
- `npm run check` - TypeScript type and syntax validation for the repository
- `npm run typecheck` - run the TypeScript compiler in `--noEmit` mode
- `npm run lint` - ESLint for source, tests, scripts, and local JS/CJS config files
- `npm run lint:fix` - apply safe lint fixes
- `npm run format` - format repository files with Prettier
- `npm run format:check` - verify formatting
- `npm test` - run the full test suite
- `npm run healthcheck` - static runtime readiness check
- `npm run healthcheck:strict` - stricter production-oriented health check
- `npm run healthcheck:live` - live Codex + Telegram probe against the configured backend and bot token
- `npm run telegram:smoke` - live Telegram API smoke test when a real bot token is available

## Architecture

```text
Telegram Message
  -> src/bot/handlers.ts
  -> src/orchestrator/router.ts
     -> src/runner/ptyManager.ts        (coding tasks -> Codex SDK or Codex CLI)
     -> src/orchestrator/skills/*.ts    (general tasks -> MCP/GitHub subagents)
  -> src/bot/formatter.ts
  -> Telegram sendMessage/editMessageText
```

Core modules:

- `src/index.ts`: bootstrap and lifecycle
- `src/config.ts`: env parsing and validation
- `src/bot/`: auth middleware, formatting, command handlers
- `src/orchestrator/`: routing + MCP client + skills
- `src/runner/ptyManager.ts`: Codex runner abstraction for SDK threads, CLI/PTy sessions, and CLI exec fallback
- `src/cron/scheduler.ts`: proactive scheduled push

Enterprise target architecture: [docs/enterprise-architecture.md](/Users/ding/Documents/Code/Github/CodexClaw/docs/enterprise-architecture.md)
Enterprise Phase 1 roadmap: [docs/phase-1-roadmap.md](/Users/ding/Documents/Code/Github/CodexClaw/docs/phase-1-roadmap.md)

## Routing and MCP Boundary

To avoid duplicated context fetch:

- **Coding requests** are sent directly to Codex (SDK or CLI backend; Codex can use its own MCP stack)
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
- Everything else falls back to Codex

Where this happens:

- Router decision order: [router.ts](/Users/ding/Documents/Code/Github/CodexClaw/src/orchestrator/router.ts)
- Skill toggles per chat: [skillRegistry.ts](/Users/ding/Documents/Code/Github/CodexClaw/src/orchestrator/skillRegistry.ts)
- Telegram command entrypoints: [handlers.ts](/Users/ding/Documents/Code/Github/CodexClaw/src/bot/handlers.ts)

Operationally, subagents are the bot's control plane. Codex remains the coding execution plane.

## Commands

General:

- `/start` - bootstrap message
- `/help` - command summary
- `/status` - show current chat status, active runner mode, workdir, model override, MCP servers, and the internal superpowers workflow phase
- `/pwd` - show the current project directory for this chat
- `/repo` - list switchable git projects under `WORKSPACE_ROOT`
- `/repo <name>` - switch the current chat to another project
- `/repo <keyword>` - fuzzy match projects; switch if only one match, otherwise list candidates
- `/repo <typo>` - suggests the closest project name when there is no direct match
- `/repo recent` - show recent projects for the current chat
- `/repo -` - switch back to the previous project
- `/new` - clear the saved Codex conversation for the current project and start fresh on the next message
- `/exec <task>` - force a one-off Codex run without saving project context
- `/auto <task>` - force a one-off fully automatic Codex run without saving project context
- `/plan <task>` - ask Codex for a plan only, without direct file modification intent
- `/continue` - replay the last blocked same-workdir Codex request once
- `/model [name|reset]` - show or set the model override for the current chat
- `/language [en|zh|zh-HK]` - show or set the system language for the current chat
- `/verbose [on|off]` - show or toggle system notices for the current chat
- `/skill list` - show skill switches for the current chat
- `/skill status` - alias of `/skill list`
- `/skill on <name>` - enable a skill for the current chat
- `/skill off <name>` - disable a skill for the current chat
- `/dev start` - start the current repo frontend server (`dev`, then `start`)
- `/dev stop` - stop the current repo frontend server
- `/dev status` - show the current repo frontend server status
- `/dev logs` - show the current repo frontend server log tail
- `/dev url` - show the detected local frontend URL
- `/sh <command>` - run a safe allowlisted Linux command in the current project (disabled by default)
- `/sh --confirm <command>` - confirm a dangerous command when writable mode is enabled
- `/restart` - restart the bot process explicitly from Telegram
- `/interrupt` - interrupt the active Codex run
- `/stop` - terminate the active Codex run
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

- `/gh commit "feat: message"` -> explicit GitHub write action
- `/gh push` -> explicit push for the current branch
- `/gh create repo my-new-repo` -> explicit sibling repo creation under `WORKSPACE_ROOT`
- `/gh confirm` -> confirm the pending GitHub write action and execute it
- plain-text write requests such as `create repo ...`, `commit`, or `push` are intercepted and converted into guidance; they no longer execute GitHub writes directly
- `/gh run tests` -> launch test job
- `/gh test status <jobId>` -> read test status/output tail

Telegram adaptation notes:

- Plain text messages behave like a normal Codex conversation turn
- Photo, document, video, audio, voice, animation, sticker, and video-note messages are also routed to Codex as structured attachment prompts
- Media captions are treated as the user request; attachment metadata and Telegram file links are included when available
- On SDK runs, files created or updated in the current Codex turn can be sent back to the Telegram user as document attachments
- `/exec` runs a one-off Codex task and does not overwrite the saved project conversation slot
- `/auto` runs a one-off Codex task with `approvalPolicy=never` on the SDK backend, or `codex exec --full-auto` on the CLI backend
- `/new` is implemented by the bot and resets the current chat session
- `/new` only clears the current project's saved Codex conversation slot
- `/status` is implemented by the bot and reports local runtime state
- `/status` also surfaces the internal `superpowers` workflow system and the last detected workflow phase for the current chat/project session
- `/repo` is implemented by the bot and switches the per-chat working directory inside `WORKSPACE_ROOT`
- `/skill` is implemented by the bot and keeps per-chat skill switches in runtime state
- `/skill` only lists toggleable bot skills; `superpowers` is shown as an internal workflow, not a toggleable skill
- `/dev` is implemented by the bot and manages one frontend server per repo workdir, shared across chats
- `/dev start` prefers `package.json` script `dev` and falls back to `start`
- `/sh` is implemented by the bot, never invokes a shell interpreter, and only accepts configured command prefixes
- `/sh` is read-only by default; dangerous prefixes can be configured and require `--confirm` when writable mode is enabled
- `/plan` translates to a planning-only prompt instead of passing a raw `/plan` slash command to Codex
- If another chat already has an active Codex run in the same workdir, the bot blocks the new request and requires `/continue` for a one-shot override
- The default system language is English; use `/language zh` or `/language zh-HK` for localized bot responses
- `/verbose off` keeps Telegram output quiet by hiding fallback, startup, and session-exit notices for the current chat

## Streaming and Reasoning Visualization

Codex output is streamed with throttled `editMessageText` updates.

- Throttle: controlled by `STREAM_THROTTLE_MS` (default `1200`)
- While Codex is still working, the bot keeps Telegram's `typing` indicator alive so the chat shows that a reply is in progress
- Long output: auto-chunked to Telegram-safe message sizes
- MarkdownV2: escaped to avoid parse failures
- Reasoning tags: `<think>...</think>` extracted and rendered as:
  - spoiler (`||...||`, default)
  - quote block (if `REASONING_RENDER_MODE=quote`)
- On `CODEX_BACKEND=sdk`, Telegram streams structured Codex SDK events and persists thread IDs per project
- On `CODEX_BACKEND=cli`, the bot prefers PTY sessions; if `node-pty` cannot spawn on the current host, it falls back to `codex exec`
- In CLI exec fallback mode, Telegram output is cleaned to hide the Codex banner, raw tool trace, `mcp startup`, and duplicate `tokens used` footer
- On macOS, startup auto-repairs `node-pty` helper execute permissions before the first PTY session

## Project-Scoped Conversation State

Conversation state is now tracked per `chat + project`, not just per chat.

- When you switch with `/repo <name>`, the bot keeps that project's last Codex session id in runtime state
- When you switch back to the same project later, the next plain-text task resumes that project's Codex thread/session
- `/new` clears only the current project's saved conversation slot; other projects in the same Telegram chat are untouched
- `/exec`, `/auto`, and `/plan` stay one-off by design and do not replace the saved project conversation
- On the SDK backend, project restore uses `resumeThread(threadId)`
- On the CLI backend, project restore uses PTY resume or `codex exec resume`

## Workspace Contention Guard

The bot now blocks a second Codex run when another bot-managed chat already has an active Codex task in the same workdir.

- the warning is strong by default because simultaneous writes in the same workdir are easy to corrupt
- `/continue` replays the most recently blocked request once for the current chat
- switching projects clears the pending blocked request
- this guard only sees bot-managed chats in this process; if you also use Codex directly in a terminal, use a separate git worktree to avoid conflicts

## Frontend Debugging Layer

The bot includes a minimal repo-scoped frontend runtime layer:

- `/dev start` starts the current repo's frontend command
- `/dev stop` stops it
- `/dev status` shows whether it is running
- `/dev logs` returns the recent output tail
- `/dev url` returns the first detected local URL from logs

Selection rules:

- prefer `package.json` script `dev`
- if `dev` is missing, fall back to `start`
- keep only one active frontend server per repo workdir
- do not expose arbitrary shell execution through `/dev`

## Backend Selection

Choose the execution backend with `CODEX_BACKEND`:

- `sdk` - preferred for new installs; avoids PTY fragility and uses persistent Codex SDK threads
- `cli` - legacy backend; uses PTY when available and falls back to `codex exec`

SDK-related options:

```bash
CODEX_BACKEND=sdk
CODEX_SDK_CONFIG={}
CODEX_SDK_SKIP_GIT_REPO_CHECK=true
CODEX_SDK_SANDBOX_MODE=workspace-write
CODEX_SDK_APPROVAL_POLICY=never
CODEX_SDK_REASONING_EFFORT=high
CODEX_SDK_NETWORK_ACCESS_ENABLED=true
CODEX_SDK_WEB_SEARCH_MODE=live
CODEX_SDK_ADDITIONAL_DIRECTORIES=["/abs/path/extra-worktree"]
```

If `CODEX_SDK_SANDBOX_MODE` is unset, the bot now defaults SDK threads to `workspace-write` so normal coding tasks can modify files inside the active repo. Set it explicitly to `read-only` only if you want analysis-only behavior.

CLI-related options:

```bash
CODEX_BACKEND=cli
CODEX_COMMAND=codex
CODEX_ARGS=
```

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
CODEX_BACKEND=sdk
CODEX_SDK_CONFIG={}
CODEX_SDK_SKIP_GIT_REPO_CHECK=true
CODEX_SDK_SANDBOX_MODE=
CODEX_SDK_APPROVAL_POLICY=
CODEX_SDK_REASONING_EFFORT=
CODEX_SDK_NETWORK_ACCESS_ENABLED=
CODEX_SDK_WEB_SEARCH_MODE=
CODEX_SDK_ADDITIONAL_DIRECTORIES=[]
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

Keep live verification output out of git history and release notes. Bot usernames, thread IDs, and chat IDs are environment-specific operator data and should be configured by each user locally or through GitHub secrets.

Recommended local release gate:

```bash
BOT_TOKEN=dummy-token ALLOWED_USER_IDS=1 npm run release:check
npm run healthcheck:live
npm run telegram:smoke
```

`v1.0.0` should only be tagged after the full release gate, Telegram smoke checks, and repository metadata sync are complete. The detailed checklist and topic sync command live in [release.md](/Users/ding/Documents/Code/Github/CodexClaw/docs/release.md).

Release references:

- [operations.md](/Users/ding/Documents/Code/Github/CodexClaw/docs/operations.md)
- [release.md](/Users/ding/Documents/Code/Github/CodexClaw/docs/release.md)
- [ecosystem.config.cjs](/Users/ding/Documents/Code/Github/CodexClaw/ecosystem.config.cjs) - PM2 compatibility shim

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

`ecosystem.config.ts` is the canonical config file. Start PM2 with `ecosystem.config.cjs`, which only bridges PM2 into the TypeScript source.

Basic flow:

```bash
pm2 start ecosystem.config.cjs
pm2 status CodexClaw
pm2 logs CodexClaw
pm2 restart CodexClaw
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
- **Codex not producing output**: verify `CODEX_BACKEND`, `CODEX_COMMAND`, and `CODEX_WORKDIR`
- **SDK backend cannot resume**: verify the host still has access to `~/.codex/sessions` and that the saved thread id belongs to the same working directory
- **Markdown parse errors**: reduce output size/context; check special characters in tool output
- **MCP failures**: run `/mcp tools <server>` first to validate server availability
- **GitHub API failures**: verify `GITHUB_TOKEN` scope (`repo`) and account permissions
- **Duplicate MCP suspicion**: ensure coding tasks are routed directly to Codex, and bot MCP is used only for `/mcp`
- **`posix_spawnp failed`**: this usually means the `node-pty` helper lost execute permissions; startup now auto-repairs it, and `npm run healthcheck` reports the result

## Reference

- Inspired by: https://github.com/RichardAtCT/claude-code-telegram
- Codex SDK reference: https://github.com/coleam00/codex-telegram-coding-assistant
- This implementation: Codex-first Node.js stack (`@openai/codex-sdk`, `telegraf`, `node-pty`, `node-cron`, MCP SDK)
