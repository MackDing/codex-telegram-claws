import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeStateStore } from "../src/runtimeStateStore.js";

test("runtime state store saves and loads MCP and skill state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-state-"));
  const file = path.join(tempDir, "runtime-state.json");
  const store = new RuntimeStateStore({
    config: {
      app: {
        name: "codex-telegram-claws",
        stateFile: file
      }
    }
  });

  await store.save({
    mcp: {
      disabledServers: ["context7"]
    },
    runner: {
      chats: {
        42: {
          preferredModel: null,
          language: "zh-HK",
          verboseOutput: true,
          currentWorkdir: "project-a",
          recentWorkdirs: ["project-a", "project-b"],
          projects: {
            "project-a": {
              lastSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              lastMode: null,
              lastExitCode: null,
              lastExitSignal: null
            }
          }
        }
      }
    },
    skills: {
      chats: {
        42: {
          enabledSkills: ["mcp"]
        }
      }
    }
  });

  const state = await store.load();

  assert.deepEqual(state.mcp, {
    disabledServers: ["context7"]
  });
  assert.deepEqual(state.runner, {
    chats: {
      42: {
        preferredModel: null,
        language: "zh-HK",
        verboseOutput: true,
        currentWorkdir: "project-a",
        recentWorkdirs: ["project-a", "project-b"],
        projects: {
          "project-a": {
            lastSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            lastMode: null,
            lastExitCode: null,
            lastExitSignal: null
          }
        }
      }
    }
  });
  assert.deepEqual(state.skills, {
    chats: {
      42: {
        enabledSkills: ["mcp"]
      }
    }
  });
});
