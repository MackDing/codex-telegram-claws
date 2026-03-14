import test from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry } from "../src/orchestrator/skillRegistry.js";

test("skill registry enables all known skills by default per chat", () => {
  const registry = new SkillRegistry({
    github: {},
    mcp: {}
  });

  assert.deepEqual(registry.list(1), [
    { name: "github", enabled: true },
    { name: "mcp", enabled: true }
  ]);
});

test("skill registry toggles skills per chat without affecting other chats", () => {
  const registry = new SkillRegistry({
    github: {},
    mcp: {}
  });

  const disabled = registry.disable(1, "github");

  assert.equal(disabled.changed, true);
  assert.equal(registry.isEnabled(1, "github"), false);
  assert.equal(registry.isEnabled(2, "github"), true);

  const enabled = registry.enable(1, "github");
  assert.equal(enabled.changed, true);
  assert.equal(registry.isEnabled(1, "github"), true);
});

test("skill registry rejects unknown skills", () => {
  const registry = new SkillRegistry({
    github: {}
  });

  assert.throws(() => registry.disable(1, "unknown"), /Unknown skill/);
});

test("skill registry exports and restores chat state", () => {
  const registry = new SkillRegistry({
    github: {},
    mcp: {}
  });
  registry.disable(1, "github");

  const snapshot = registry.exportState();
  const restored = new SkillRegistry({
    github: {},
    mcp: {}
  });
  restored.restoreState(snapshot);

  assert.equal(restored.isEnabled(1, "github"), false);
  assert.equal(restored.isEnabled(1, "mcp"), true);
});

test("skill registry reports idempotent enable and disable operations", () => {
  const registry = new SkillRegistry({
    github: {},
    mcp: {}
  });

  assert.equal(registry.enable(1, "github").changed, false);
  assert.equal(registry.disable(1, "github").changed, true);
  assert.equal(registry.disable(1, "github").changed, false);
});
