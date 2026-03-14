import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("telegram smoke exits with a helpful error when BOT_TOKEN is missing", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/telegramSmoke.ts"],
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
