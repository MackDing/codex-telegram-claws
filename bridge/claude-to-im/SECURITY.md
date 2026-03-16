# Security

## Credential Storage

All credentials are stored in `~/.claude-to-im/config.env` with file permissions set to `600` (owner read/write only). This file is created during `setup` and never committed to version control.

The `.gitignore` excludes `config.env` to prevent accidental commits.

## Log Redaction

All tokens and secrets are masked in log output and terminal display. Only the last 4 characters of any secret are shown (e.g., `****abcd`). This applies to:

- Setup wizard confirmation output
- `reconfigure` command display
- `logs` command output
- Error messages

## Threat Model

This project operates as a **single-user local daemon**:

- The daemon runs on the user's local machine under their user account
- No network listeners are opened; the daemon connects outbound to IM platform APIs only
- Authentication is handled by the IM platform's bot token mechanism
- Access control is enforced via allowed user/channel ID lists configured per platform

The primary threats are:

- **Token leakage**: Mitigated by file permissions, log redaction, and `.gitignore`
- **Unauthorized message senders**: Mitigated by allowed user ID filtering per platform
- **Local privilege escalation**: Mitigated by running as unprivileged user process

## Token Rotation

To rotate compromised or expired tokens:

1. Revoke the old token on the IM platform
2. Generate a new token
3. Run `/claude-to-im reconfigure` to update the stored credentials
4. Run `/claude-to-im stop` then `/claude-to-im start` to apply changes

## Leak Response

If you suspect a token has been leaked:

1. **Immediately revoke** the token on the respective IM platform
2. Run `/claude-to-im stop` to halt the daemon
3. Run `/claude-to-im reconfigure` with a new token
4. Review `~/.claude-to-im/logs/` for unauthorized activity
5. Run `/claude-to-im start` with the new credentials
