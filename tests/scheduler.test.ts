import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/cron/scheduler.js";

test("buildDailySummary formats commit and diff totals", async () => {
  const scheduler = new Scheduler({
    bot: {
      telegram: {
        sendMessage: async () => ({})
      }
    },
    config: {
      cron: {
        dailySummary: "0 9 * * *",
        timezone: "UTC"
      },
      github: {
        defaultWorkdir: process.cwd()
      },
      telegram: {
        proactiveUserIds: ["1"]
      }
    }
  });

  scheduler.git = {
    log: async () => ({
      total: 1,
      all: [{ hash: "abcdef0", message: "feat: ok" }]
    }),
    diffSummary: async () => ({
      changed: 2,
      insertions: 5,
      deletions: 1
    })
  };

  const summary = await scheduler.buildDailySummary();

  assert.match(summary, /Daily Code Summary/);
  assert.match(summary, /Commits: 1/);
  assert.match(summary, /Files changed: 2/);
  assert.match(summary, /abcdef0 feat: ok/);
});
