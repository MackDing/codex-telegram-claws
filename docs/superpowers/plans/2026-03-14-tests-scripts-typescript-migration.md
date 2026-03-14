# Tests And Scripts TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the remaining top-level test files and executable script entrypoints from JavaScript to TypeScript without changing repository behavior or the existing `tsx` workflow.

**Architecture:** Migrate the script entrypoints first so the executable edges of the repo resolve through TypeScript before bulk-renaming the tests. Then migrate the tests in behavior-aligned batches, keeping NodeNext `.js` import specifiers and adding only narrow local typing for mocks, fixtures, and thrown errors. Finish with a residual JavaScript audit so only intentionally retained config files remain in `JS/CJS`.

**Tech Stack:** Node.js 20+, TypeScript 5.x, tsx, node:test, ESLint, Prettier

---

## File Map

### Script Entrypoints

- Move: `scripts/healthcheck.js` -> `scripts/healthcheck.ts`
- Move: `scripts/telegramSmoke.js` -> `scripts/telegramSmoke.ts`
- Modify: `package.json`
- Create: `tests/telegramSmoke.test.ts`

### Foundational Test Files

- Move: `tests/commandUtils.test.js` -> `tests/commandUtils.test.ts`
- Move: `tests/formatter.test.js` -> `tests/formatter.test.ts`
- Move: `tests/i18n.test.js` -> `tests/i18n.test.ts`
- Move: `tests/middleware.test.js` -> `tests/middleware.test.ts`
- Move: `tests/ptyPreflight.test.js` -> `tests/ptyPreflight.test.ts`

### Service And State Test Files

- Move: `tests/config.test.js` -> `tests/config.test.ts`
- Move: `tests/mcpClient.test.js` -> `tests/mcpClient.test.ts`
- Move: `tests/router.test.js` -> `tests/router.test.ts`
- Move: `tests/runtimeStateStore.test.js` -> `tests/runtimeStateStore.test.ts`
- Move: `tests/scheduler.test.js` -> `tests/scheduler.test.ts`
- Move: `tests/skillRegistry.test.js` -> `tests/skillRegistry.test.ts`

### Heavy Mock And Async Test Files

- Move: `tests/githubSkill.test.js` -> `tests/githubSkill.test.ts`
- Move: `tests/healthcheck.test.js` -> `tests/healthcheck.test.ts`
- Move: `tests/mcpSkill.test.js` -> `tests/mcpSkill.test.ts`
- Move: `tests/ptyManager.test.js` -> `tests/ptyManager.test.ts`
- Move: `tests/shellManager.test.js` -> `tests/shellManager.test.ts`

### Expected Non-Changes

- Keep: `eslint.config.js`
- Keep: `ecosystem.config.cjs`
- Keep: `tests/typecheck/*.ts`

## Chunk 1: Script Entrypoints

### Task 1: Migrate `healthcheck` To TypeScript

**Files:**

- Move: `scripts/healthcheck.js` -> `scripts/healthcheck.ts`
- Move: `tests/healthcheck.test.js` -> `tests/healthcheck.test.ts`
- Modify: `package.json`
- Test: `tests/healthcheck.test.ts`

- [ ] **Step 1: Rename the healthcheck regression test first so the focused suite already runs from TypeScript**

Keep all imports using `.js` specifiers and preserve every existing assertion.

Run:

```bash
node --import tsx --test tests/healthcheck.test.ts
```

Expected: PASS. If TypeScript complains about helper arguments or thrown values, add only local annotations in the test file.

- [ ] **Step 2: Rename `scripts/healthcheck.js` to `.ts` and update package scripts**

Update these `package.json` entries:

```json
{
  "healthcheck": "tsx scripts/healthcheck.ts",
  "healthcheck:strict": "tsx scripts/healthcheck.ts --strict",
  "healthcheck:live": "tsx scripts/healthcheck.ts --codex-live --telegram-live"
}
```

Keep the runtime imports unchanged:

```ts
import { loadConfig } from "../src/config.js";
import { runHealthcheck } from "../src/ops/healthcheck.js";
```

- [ ] **Step 3: Add explicit script-local typing without changing output**

Use narrow typing for config-load and option parsing only:

```ts
const strict = process.argv.includes("--strict");
const telegramLiveCheck = process.argv.includes("--telegram-live");
const codexLiveCheck = process.argv.includes("--codex-live");

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[FAIL] config: ${message}`);
  process.exit(1);
}
```

- [ ] **Step 4: Run the focused script verification**

Run:

```bash
npm run typecheck
BOT_TOKEN=dummy-token ALLOWED_USER_IDS=1 npm run healthcheck
node --import tsx --test tests/healthcheck.test.ts
```

Expected:

- `tsc --noEmit` passes
- healthcheck exits `0`
- focused healthcheck tests pass

- [ ] **Step 5: Commit the healthcheck slice**

```bash
git add scripts/healthcheck.ts tests/healthcheck.test.ts package.json
git commit -m "refactor: migrate healthcheck entrypoint to typescript"
```

### Task 2: Migrate `telegramSmoke` To TypeScript And Add A Non-Live Regression Test

**Files:**

- Move: `scripts/telegramSmoke.js` -> `scripts/telegramSmoke.ts`
- Modify: `package.json`
- Create: `tests/telegramSmoke.test.ts`
- Test: `tests/telegramSmoke.test.ts`

- [ ] **Step 1: Add a CLI regression test that does not require Telegram credentials**

Create `tests/telegramSmoke.test.ts` and verify the current entrypoint behavior before the rename by executing the script in a subprocess with `BOT_TOKEN` unset.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("telegram smoke exits with a helpful error when BOT_TOKEN is missing", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/telegramSmoke.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_TOKEN: ""
      },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing BOT_TOKEN/);
});
```

Run:

```bash
node --import tsx --test tests/telegramSmoke.test.ts
```

Expected: PASS against the current JavaScript entrypoint.

- [ ] **Step 2: Rename the script to `.ts` and update the package script**

Update:

```json
{
  "telegram:smoke": "tsx scripts/telegramSmoke.ts"
}
```

Then update the regression test subprocess target from `scripts/telegramSmoke.js` to `scripts/telegramSmoke.ts`.

- [ ] **Step 3: Add minimal Telegram response types directly in the script**

Do not build a large Telegram schema. Model only the fields read by the script:

```ts
interface TelegramBotUser {
  id: number;
  username: string;
}

interface TelegramSendMessageResult {
  message_id: number;
}

interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
  description?: string;
}

interface TelegramApiFailure {
  ok: false;
  description?: string;
}

type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;
```

Use `unknown` at the JSON boundary, then narrow once:

```ts
const getMePayload =
  (await getMeResponse.json()) as TelegramApiResponse<TelegramBotUser>;
```

- [ ] **Step 4: Run focused verification for the migrated smoke script**

Run:

```bash
npm run typecheck
node --import tsx --test tests/telegramSmoke.test.ts
```

Expected: PASS.

Optional only if real credentials are intentionally available:

```bash
npm run telegram:smoke
```

- [ ] **Step 5: Commit the smoke-script slice**

```bash
git add scripts/telegramSmoke.ts tests/telegramSmoke.test.ts package.json
git commit -m "refactor: migrate telegram smoke entrypoint to typescript"
```

## Chunk 2: Test Suite Migration

### Task 3: Convert Foundational Tests With Minimal Typing

**Files:**

- Move: `tests/commandUtils.test.js` -> `tests/commandUtils.test.ts`
- Move: `tests/formatter.test.js` -> `tests/formatter.test.ts`
- Move: `tests/i18n.test.js` -> `tests/i18n.test.ts`
- Move: `tests/middleware.test.js` -> `tests/middleware.test.ts`
- Move: `tests/ptyPreflight.test.js` -> `tests/ptyPreflight.test.ts`
- Test: `tests/commandUtils.test.ts`
- Test: `tests/formatter.test.ts`
- Test: `tests/i18n.test.ts`
- Test: `tests/middleware.test.ts`
- Test: `tests/ptyPreflight.test.ts`

- [ ] **Step 1: Rename the foundational tests in one batch**

Keep imports pointed at `.js` module specifiers under `src/`. Do not change assertions or file structure.

- [ ] **Step 2: Add only the local annotations TypeScript actually requires**

Most of these files should stay close to a pure rename. If a helper needs typing, prefer tiny structural annotations like:

```ts
const middleware = createAuthMiddleware({
  telegram: {
    allowedUserIds: ["123"]
  }
});

await middleware({ from: { id: 123 } }, async () => {
  called = true;
});
```

If Telegraf-compatible callback shapes need help, annotate the test-local argument instead of exporting new production types.

- [ ] **Step 3: Run the focused foundational suite**

Run:

```bash
node --import tsx --test \
  tests/commandUtils.test.ts \
  tests/formatter.test.ts \
  tests/i18n.test.ts \
  tests/middleware.test.ts \
  tests/ptyPreflight.test.ts
```

Expected: PASS.

- [ ] **Step 4: Re-run typecheck after the foundational batch**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the foundational test batch**

```bash
git add \
  tests/commandUtils.test.ts \
  tests/formatter.test.ts \
  tests/i18n.test.ts \
  tests/middleware.test.ts \
  tests/ptyPreflight.test.ts
git commit -m "refactor: migrate foundational tests to typescript"
```

### Task 4: Convert Config, Service, And State Tests

**Files:**

- Move: `tests/config.test.js` -> `tests/config.test.ts`
- Move: `tests/mcpClient.test.js` -> `tests/mcpClient.test.ts`
- Move: `tests/router.test.js` -> `tests/router.test.ts`
- Move: `tests/runtimeStateStore.test.js` -> `tests/runtimeStateStore.test.ts`
- Move: `tests/scheduler.test.js` -> `tests/scheduler.test.ts`
- Move: `tests/skillRegistry.test.js` -> `tests/skillRegistry.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/mcpClient.test.ts`
- Test: `tests/router.test.ts`
- Test: `tests/runtimeStateStore.test.ts`
- Test: `tests/scheduler.test.ts`
- Test: `tests/skillRegistry.test.ts`

- [ ] **Step 1: Rename the service/state tests and keep helper boundaries local**

These files are the first place where local helper typing matters. Use narrow helper signatures rather than broad `any`.

Examples:

```ts
function withEnv<T>(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => T
): T {
  // existing body unchanged
}

function createSkill(supports: (text: string) => boolean) {
  return { supports };
}
```

- [ ] **Step 2: Fix `unknown` and mutable collection typing only where the compiler asks for it**

Typical adjustments for this batch:

- explicitly type `console.warn` stubs and restore functions
- type `Map` payloads in config helpers
- type fake server transport close handlers in MCP client tests

Avoid adding test-only exports to production modules.

- [ ] **Step 3: Run the focused service/state suite**

Run:

```bash
node --import tsx --test \
  tests/config.test.ts \
  tests/mcpClient.test.ts \
  tests/router.test.ts \
  tests/runtimeStateStore.test.ts \
  tests/scheduler.test.ts \
  tests/skillRegistry.test.ts
```

Expected: PASS.

- [ ] **Step 4: Re-run typecheck after the service/state batch**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the service/state batch**

```bash
git add \
  tests/config.test.ts \
  tests/mcpClient.test.ts \
  tests/router.test.ts \
  tests/runtimeStateStore.test.ts \
  tests/scheduler.test.ts \
  tests/skillRegistry.test.ts
git commit -m "refactor: migrate service tests to typescript"
```

### Task 5: Convert Heavy Mock And Async Tests

**Files:**

- Move: `tests/githubSkill.test.js` -> `tests/githubSkill.test.ts`
- Move: `tests/mcpSkill.test.js` -> `tests/mcpSkill.test.ts`
- Move: `tests/ptyManager.test.js` -> `tests/ptyManager.test.ts`
- Move: `tests/shellManager.test.js` -> `tests/shellManager.test.ts`
- Test: `tests/githubSkill.test.ts`
- Test: `tests/mcpSkill.test.ts`
- Test: `tests/ptyManager.test.ts`
- Test: `tests/shellManager.test.ts`

- [ ] **Step 1: Rename the remaining mock-heavy test files**

Keep behavior identical. This batch is likely to surface the most compiler noise because these tests stub large object graphs and async collaborators.

- [ ] **Step 2: Add narrow helper types for overrides, fake clients, and collected events**

Prefer small local aliases like:

```ts
type ManagerOverrides = {
  runnerCwd?: string;
  workspaceRoot?: string;
  backend?: "cli" | "sdk";
  telegram?: {
    sendMessage: (...args: unknown[]) => Promise<unknown>;
    editMessageText: (...args: unknown[]) => Promise<unknown>;
    deleteMessage: (...args: unknown[]) => Promise<unknown>;
  };
  codexClientFactory?: () => {
    startThread: (options?: Record<string, unknown>) => {
      id: string | null;
      runStreamed: () => Promise<{ events: AsyncIterable<unknown> }>;
    };
  };
};
```

Other likely fixes in this batch:

- `calls` arrays in fake Codex client helpers
- `closes` arrays in MCP-related tests
- subprocess result strings and regex helpers in shell tests
- `await`ed stub return values currently inferred as `{}` or `never`

- [ ] **Step 3: Run the focused heavy-mock suite**

Run:

```bash
node --import tsx --test \
  tests/githubSkill.test.ts \
  tests/mcpSkill.test.ts \
  tests/ptyManager.test.ts \
  tests/shellManager.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the full test suite after the last rename batch**

Run:

```bash
npm test
npm run typecheck
```

Expected:

- full suite passes
- typecheck passes

- [ ] **Step 5: Commit the final test migration batch**

```bash
git add \
  tests/githubSkill.test.ts \
  tests/mcpSkill.test.ts \
  tests/ptyManager.test.ts \
  tests/shellManager.test.ts
git commit -m "refactor: finish tests typescript migration"
```

## Chunk 3: Final Verification And Residual JavaScript Audit

### Task 6: Confirm Only Intentional JavaScript Remains

**Files:**

- Modify: `package.json` if any script references still point at removed `.js` files
- Verify: `tests/`
- Verify: `scripts/`
- Verify: `eslint.config.js`
- Verify: `ecosystem.config.cjs`

- [ ] **Step 1: Audit for leftover JavaScript in `tests/` and `scripts/`**

Run:

```bash
rg --files tests scripts | rg '\.js$'
```

Expected: no output.

- [ ] **Step 2: Audit package scripts and executable entrypoints**

Run:

```bash
node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); console.log(pkg.scripts.healthcheck); console.log(pkg.scripts["healthcheck:strict"]); console.log(pkg.scripts["healthcheck:live"]); console.log(pkg.scripts["telegram:smoke"]);'
```

Expected output:

- `tsx scripts/healthcheck.ts`
- `tsx scripts/healthcheck.ts --strict`
- `tsx scripts/healthcheck.ts --codex-live --telegram-live`
- `tsx scripts/telegramSmoke.ts`

- [ ] **Step 3: Run the repository verification gate**

Run:

```bash
npm run check
npm run lint
npm run format:check
npm test
BOT_TOKEN=dummy-token ALLOWED_USER_IDS=1 npm run healthcheck
```

Expected: all commands exit `0`.

Do not claim success without fresh output from this exact verification set.

- [ ] **Step 4: Inspect the final change surface**

Run:

```bash
git diff --stat
git status --short
```

Expected:

- diff shows only the intended `tests/`, `scripts/`, and `package.json` changes
- status is clean except for intentionally staged or just-created migration files

- [ ] **Step 5: Commit the audit and any final fixups**

If Step 4 required any leftover script-reference cleanup, commit it with:

```bash
git add package.json tests scripts
git commit -m "refactor: finish tests and scripts typescript migration"
```

If no additional changes remain after the earlier commits, skip this commit and proceed directly to execution handoff.
