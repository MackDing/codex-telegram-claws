# Feishu Bridge (claude-to-im Migration)

This repository now includes a full `claude-to-im` bridge runtime at:

- `bridge/claude-to-im`

The bridge keeps the original Feishu card-based permission approval flow, including:

- tool permission request cards
- `Allow` / `Deny` card interaction callbacks
- stream updates and message routing

## Quick Start

1. Initialize local bridge config:

```bash
npm run feishu:setup
```

2. Edit `~/.codexclaw-bridge/config.env`:

- `CTI_RUNTIME=codex`
- `CTI_ENABLED_CHANNELS=feishu`
- `CTI_DEFAULT_WORKDIR=/absolute/path/to/CodexClaw`
- `CTI_FEISHU_APP_ID=...`
- `CTI_FEISHU_APP_SECRET=...`
- Optional:
  - `CTI_FEISHU_DOMAIN=https://open.feishu.cn`
  - `CTI_FEISHU_ALLOWED_USERS=ou_xxx,ou_yyy`

3. Install bridge dependencies:

```bash
npm run feishu:install
```

4. Start and verify:

```bash
npm run feishu:start
npm run feishu:status
npm run feishu:logs
```

5. Diagnose issues:

```bash
npm run feishu:doctor
```

## Feishu Two-Phase Publish Checklist

Use the original guide at:

- `bridge/claude-to-im/references/setup-guides.md`

High-level sequence:

1. Phase 1: add permissions + enable bot + publish/approve.
2. Start bridge (`npm run feishu:start`).
3. Phase 2: configure long connection events and callback (`card.action.trigger`) + publish/approve again.

This two-phase publish is required for Feishu callback validation and card button interaction.
