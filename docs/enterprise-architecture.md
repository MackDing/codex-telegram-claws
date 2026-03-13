# Enterprise Architecture

## Purpose

This document defines the target architecture when `codex-telegram-claws` is deployed as a financial enterprise engineering assistant for multiple subsidiary CTO teams. The current repository is a strong single-host beta. The enterprise target is a controlled multi-host platform.

## Target Operating Model

- One central Telegram control plane, owned by the platform team.
- One worker agent per company, business unit, or regulated environment.
- Each worker runs close to its own repositories, Codex CLI, MCP servers, and secrets.
- The control plane never executes local shell or git actions directly against remote business units.

## Logical Architecture

```text
Telegram User
  -> Control Plane API / Bot Gateway
     -> Identity + RBAC + Policy Engine
     -> Audit Log + Event Bus
     -> Worker Registry
        -> Subsidiary Worker A
           -> Codex CLI
           -> MCP Servers
           -> Git / CI / Safe Shell
        -> Subsidiary Worker B
        -> Subsidiary Worker C
```

## Core Components

### Control Plane

- Terminates Telegram traffic and normalizes commands.
- Resolves tenant, user role, target worker, and policy set.
- Stores chat state, project selection, model override, and approval state.
- Emits immutable audit events for every privileged operation.

### Worker Agent

- Runs on the subsidiary-owned host or VPC.
- Owns local `node-pty`, Codex CLI, repo checkout, shell allowlist, MCP clients, and GitHub access.
- Accepts signed task requests from the control plane.
- Returns structured task events, output chunks, status, and final result.

### Policy Engine

- Controls who can use which model, worker, repo, MCP server, shell command, and GitHub operation.
- Enforces read-only vs write permissions.
- Requires approval for dangerous actions such as `git push`, repo creation, or production release actions.

### Audit And Observability

- Append-only audit trail for commands, approvals, model usage, and output status.
- Structured logs, metrics, and health endpoints per worker.
- Export path to SIEM or internal compliance tooling.

## Security Baseline

- Replace `ALLOWED_USER_IDS`-only trust with SSO/OIDC backed identity.
- Add RBAC roles such as `platform_admin`, `subsidiary_cto`, `reviewer`, and `auditor`.
- Store tokens in Vault, KMS, or another enterprise secret manager.
- Require one service account per worker host.
- Enforce one polling instance per bot token, or move the control plane to webhooks.
- Keep shell disabled by default. Enable only per worker policy.

## Subagent Strategy

Subagents remain the control-plane execution units. In the enterprise model:

- `codex` stays the coding execution surface.
- `github` becomes a governed change-management subagent.
- `mcp` becomes a governed enterprise context subagent.
- New subagents should cover architecture review, security control review, release governance, and dependency risk review.

Subagents should be triggered only after:

- policy validation
- worker selection
- tenant and repo authorization
- optional approval checks for high-risk actions

## Recommended Deployment Phases

### Phase 1: Harden Current Single-Host Beta

- Migrate core runtime modules to TypeScript.
- Add structured logs and machine-readable health output.
- Add real Telegram regression checks beyond `getMe`.
- Introduce approval gates for dangerous shell and GitHub operations.

### Phase 2: Introduce Control Plane + Worker Split

- Move Telegram bot logic into a central service.
- Convert the current runtime into a worker daemon with a signed RPC interface.
- Persist chat state and audit events in a database instead of a local JSON file.

### Phase 3: Enterprise Governance

- Integrate SSO/OIDC, RBAC, and centralized policy.
- Add multi-tenant worker registry and tenant-scoped routing.
- Add formal release, rollback, and disaster recovery procedures.

## TypeScript Recommendation

For enterprise rollout, migrate the following first:

- `src/config.js`
- `src/orchestrator/router.js`
- `src/orchestrator/skillRegistry.js`
- `src/orchestrator/mcpClient.js`
- `src/runner/ptyManager.js`
- `src/runner/shellManager.js`

TypeScript matters here because config shape, skill contracts, worker RPC payloads, and audit event schemas must remain stable across teams and releases.

## First-Time Installation Guidance For Subsidiaries

- Install Node.js 20+ and Codex CLI.
- Complete `codex login` on the worker host before starting the bot.
- Use a dedicated service account and a dedicated bot token per environment.
- Set `WORKSPACE_ROOT`, `CODEX_WORKDIR`, and `GITHUB_DEFAULT_WORKDIR` to controlled directories only.
- Start with `SHELL_ENABLED=false`.
- Run:

```bash
npm install
npm run ci
npm run healthcheck:strict
npm run telegram:smoke
```

- Deploy with PM2 or another formal supervisor, not an ad hoc terminal session.

## Current Gap Summary

The current repository already has:

- PTY fallback and PTY preflight repair
- per-project chat context
- MCP and GitHub subagents
- local health checks, CI, smoke checks, and release workflow

It still lacks:

- multi-worker control plane
- enterprise identity and RBAC
- approvals and policy enforcement
- centralized audit storage
- tenant isolation
- TypeScript contracts for long-term maintainability
