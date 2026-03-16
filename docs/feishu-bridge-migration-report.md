# Feishu Bridge Migration Report

Date: 2026-03-16

## 1. Goal

Integrate a full Feishu bridge workflow into `CodexClaw`, including card-based permission approval interactions, by migrating the `claude-to-im` bridge runtime into this repository while keeping existing Telegram behavior unchanged.

## 2. Scope Completed

### 2.1 Vendored bridge runtime

Added full bridge runtime under:

- `bridge/claude-to-im/`

This includes:

- Feishu adapter and callback flow (`card.action.trigger`)
- permission request / allow / deny interaction pipeline
- daemon lifecycle scripts (`start`, `stop`, `status`, `logs`)
- diagnostics script (`doctor`)
- setup references and guides

### 2.2 Root-level command integration

Updated root scripts in `package.json`:

- `feishu:install`
- `feishu:setup`
- `feishu:start`
- `feishu:stop`
- `feishu:status`
- `feishu:logs`
- `feishu:doctor`

### 2.3 Setup helper

Added:

- `scripts/feishuBridgeSetup.sh`

Behavior:

- initializes bridge runtime home
- creates config from example if missing
- sets defaults for this repo:
  - `CTI_RUNTIME=codex`
  - `CTI_ENABLED_CHANNELS=feishu`
  - `CTI_DEFAULT_WORKDIR=/absolute/path/to/CodexClaw`

### 2.4 Runtime isolation to avoid conflict

Configured wrapper commands to use isolated defaults:

- `CTI_HOME=~/.codexclaw-bridge`
- `CTI_LAUNCHD_LABEL=com.codexclaw.feishu.bridge`

Patched scripts to respect custom label/home:

- `bridge/claude-to-im/scripts/supervisor-macos.sh`
- `bridge/claude-to-im/scripts/doctor.sh`

### 2.5 Documentation

Added:

- `docs/feishu-bridge.md`
- `docs/feishu-bridge-migration-report.md` (this file)

Updated:

- `README.md` (new Feishu bridge section + doc link)
- `.gitignore` (`bridge/claude-to-im/dist/`)

## 3. Verification Performed

### 3.1 Bridge checks

- `npm run feishu:install` passed
- `npm --prefix bridge/claude-to-im run build` passed
- `npm run feishu:status` works with isolated runtime path
- `npm run feishu:doctor` works; current remaining prerequisite is Codex auth

Doctor current expected blocker:

- Codex auth not configured (`codex auth login` or `OPENAI_API_KEY`)

### 3.2 Existing project regression checks

- `npm run check` passed
- `npm run lint` passed
- `npm test` passed (`107` passed, `0` failed)

## 4. Files Changed

- `.gitignore`
- `README.md`
- `package.json`
- `scripts/feishuBridgeSetup.sh`
- `docs/feishu-bridge.md`
- `docs/feishu-bridge-migration-report.md`
- `bridge/claude-to-im/**` (vendored runtime + small script patches)

Also added planning/log files during migration:

- `task_plan.md`
- `findings.md`
- `progress.md`

## 5. Notes And Risks

1. Vendored bridge code is large. Reviewers should focus on root integration points first, then sampled bridge scripts.
2. Runtime now has two independent operation modes:
   - existing Telegram bot (`npm run start`)
   - Feishu bridge runtime (`npm run feishu:*`)
3. Feishu requires two-phase publish in Feishu Open Platform for callback/card interaction to become effective.
4. Third-party code attribution/license must be preserved (`bridge/claude-to-im/LICENSE`, MIT).

## 6. Recommended Branch + PR Flow

Use a feature branch before merging into `main`:

```bash
git checkout -b feature/feishu-bridge-migration
git add .gitignore README.md package.json scripts/feishuBridgeSetup.sh docs/feishu-bridge.md docs/feishu-bridge-migration-report.md bridge/claude-to-im
git commit -m "feat: migrate full feishu bridge with card-based permission workflow"
git push -u origin feature/feishu-bridge-migration
```

Then open PR:

- Base: `main`
- Compare: `feature/feishu-bridge-migration`
- Title suggestion:
  - `feat: integrate feishu bridge runtime with card-based approval workflow`

PR checklist:

1. Confirm `npm run check`, `npm run lint`, and `npm test` are green.
2. Confirm `npm run feishu:doctor` output only shows expected environment-specific items (auth/credentials).
3. Confirm no secrets are committed (`.env`, tokens, IDs).
4. Keep PR description explicit that bridge runtime is vendored under `bridge/claude-to-im`.

## 7. Post-Merge Operator Steps

On deployment host:

1. `npm install`
2. `npm run feishu:install`
3. `npm run feishu:setup`
4. Edit `~/.codexclaw-bridge/config.env` with Feishu credentials
5. `codex auth login` (or set API key)
6. `npm run feishu:start`
7. `npm run feishu:status`
8. `npm run feishu:logs`
