import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PtyManager } from "../src/runner/ptyManager.js";

function createManager(overrides = {}) {
  const runnerCwd = overrides.runnerCwd || process.cwd();
  const workspaceRoot = overrides.workspaceRoot || runnerCwd;
  return new PtyManager({
    bot: {
      telegram: {
        sendMessage: async () => ({})
      }
    },
    config: {
      runner: {
        command: "codex",
        args: [],
        cwd: runnerCwd,
        throttleMs: 10,
        maxBufferChars: 1000,
        telegramChunkSize: 3900
      },
      workspace: {
        root: workspaceRoot
      },
      reasoning: {
        mode: "spoiler"
      },
      mcp: {
        servers: [{ name: "context7" }, { name: "sequential-thinking" }]
      }
    }
  });
}

test("pty manager stores model preference per chat", () => {
  const manager = createManager();

  manager.setPreferredModel(123, "gpt-5-codex");
  const status = manager.getStatus(123);

  assert.equal(status.preferredModel, "gpt-5-codex");

  manager.clearPreferredModel(123);
  assert.equal(manager.getStatus(123).preferredModel, null);
});

test("pty manager status exposes runner workdir and MCP server names", () => {
  const manager = createManager();
  const status = manager.getStatus(456);

  assert.equal(status.workdir, process.cwd());
  assert.equal(status.relativeWorkdir, ".");
  assert.equal(status.workspaceRoot, process.cwd());
  assert.deepEqual(status.mcpServers, ["context7", "sequential-thinking"]);
  assert.equal(status.active, false);
});

test("pty manager lists git projects under workspace root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-workspace-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  const projects = manager.listProjects();

  assert.deepEqual(
    projects.map((project) => project.relativePath),
    ["project-a", "project-b"]
  );
});

test("pty manager switches workdir within workspace root and resets session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-switch-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  const result = manager.switchWorkdir(99, "project-b");

  assert.equal(result.relativePath, "project-b");
  assert.equal(manager.getStatus(99).workdir, projectB);
  assert.equal(manager.getStatus(99).relativeWorkdir, "project-b");
});

test("pty manager tracks recent projects and can switch back to the previous workdir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-history-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const projectC = path.join(root, "project-c");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(projectC, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));
  fs.mkdirSync(path.join(projectC, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  manager.switchWorkdir(77, "project-b");
  manager.switchWorkdir(77, "project-c");

  assert.deepEqual(
    manager.getRecentProjects(77).map((project) => project.relativePath),
    ["project-c", "project-b", "project-a"]
  );

  const previous = manager.switchToPreviousWorkdir(77);

  assert.equal(previous.relativePath, "project-b");
  assert.equal(manager.getStatus(77).relativeWorkdir, "project-b");
});

test("pty manager keeps project conversation slots isolated per workdir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-project-sessions-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });

  manager.getProjectState(55, projectA).lastSessionId = "11111111-1111-1111-1111-111111111111";
  manager.switchWorkdir(55, "project-b");
  manager.getProjectState(55, projectB).lastSessionId = "22222222-2222-2222-2222-222222222222";

  assert.equal(manager.getStatus(55).projectSessionId, "22222222-2222-2222-2222-222222222222");

  manager.switchWorkdir(55, "project-a");
  assert.equal(manager.getStatus(55).projectSessionId, "11111111-1111-1111-1111-111111111111");
});

test("pty manager exports and restores per-project conversation state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-project-export-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(projectA, ".git"));
  fs.mkdirSync(path.join(projectB, ".git"));

  const manager = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });
  manager.getProjectState(99, projectA).lastSessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  manager.switchWorkdir(99, "project-b");
  manager.getProjectState(99, projectB).lastSessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  const restored = createManager({
    workspaceRoot: root,
    runnerCwd: projectA
  });
  restored.restoreState(manager.exportState());

  assert.equal(restored.getStatus(99).relativeWorkdir, "project-b");
  assert.equal(restored.getStatus(99).projectSessionId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  restored.switchWorkdir(99, "project-a");
  assert.equal(restored.getStatus(99).projectSessionId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
});
