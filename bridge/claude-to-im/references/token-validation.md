# Token Validation Commands

After writing config.env, validate each enabled platform's credentials to catch typos and configuration errors early.

## Telegram

```bash
curl -s "https://api.telegram.org/bot${TOKEN}/getMe"
```
Expected: response contains `"ok":true`. If not, the Bot Token is invalid — re-check with @BotFather.

## Discord

Verify token format matches: `[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`

A format mismatch means the token was copied incorrectly from the Discord Developer Portal.

## Feishu / Lark

```bash
curl -s -X POST "${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{"app_id":"...","app_secret":"..."}'
```
Expected: response contains `"code":0`. If not, check that App ID and App Secret match the Feishu Developer Console.

## QQ

Step 1 — Get access token:
```bash
curl -s -X POST "https://bots.qq.com/app/getAppAccessToken" \
  -H "Content-Type: application/json" \
  -d '{"appId":"...","clientSecret":"..."}'
```
Expected: response contains `access_token`.

Step 2 — Verify gateway connectivity:
```bash
curl -s "https://api.sgroup.qq.com/gateway" \
  -H "Authorization: QQBot <access_token>"
```
Expected: response contains a gateway URL.

If either step fails, verify the App ID and App Secret from https://q.qq.com.
