import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/orchestrator/router.js";

function createSkill(supports: (text: string) => boolean) {
  return { supports };
}

test("router prioritizes github skill when it claims the message", async () => {
  const router = new Router({
    skills: {
      github: createSkill(() => true),
      mcp: createSkill(() => false)
    }
  });

  const route = await router.routeMessage("push this repo", {
    chatId: 1
  });

  assert.deepEqual(route, {
    target: "skill",
    skill: "github",
    payload: "push this repo"
  });
});

test("router routes explicit MCP messages to mcp skill", async () => {
  const router = new Router({
    skills: {
      github: createSkill(() => false),
      mcp: createSkill((text) => text.startsWith("/mcp"))
    }
  });

  const route = await router.routeMessage("/mcp tools filesystem", {
    chatId: 1
  });

  assert.deepEqual(route, {
    target: "skill",
    skill: "mcp",
    payload: "/mcp tools filesystem"
  });
});

test("router sends coding tasks directly to codex PTY", async () => {
  const router = new Router({
    skills: {
      github: createSkill(() => false),
      mcp: createSkill(() => false)
    }
  });

  const route = await router.routeMessage(
    "Please fix src/index.ts and run tests",
    {
      chatId: 1
    }
  );

  assert.deepEqual(route, {
    target: "pty",
    prompt: "Please fix src/index.ts and run tests"
  });
});

test("router sends generic non-command requests to codex PTY", async () => {
  const router = new Router({
    skills: {
      github: createSkill(() => false),
      mcp: createSkill(() => false)
    }
  });

  const route = await router.routeMessage("who are u?", {
    chatId: 1
  });

  assert.deepEqual(route, {
    target: "pty",
    prompt: "who are u?"
  });
});

test("router falls back to PTY when no skill matches and no MCP skill exists", async () => {
  const router = new Router({
    skills: {
      github: createSkill(() => false),
      mcp: null
    }
  });

  const route = await router.routeMessage("hello there", {
    chatId: 1
  });

  assert.deepEqual(route, {
    target: "pty",
    prompt: "hello there"
  });
});

test("router skips disabled skills for the current chat", async () => {
  const router = new Router({
    skills: {
      github: createSkill(() => true),
      mcp: createSkill(() => false)
    },
    isSkillEnabled: (chatId, skillName) =>
      !(chatId === 9 && skillName === "github")
  });

  const route = await router.routeMessage("push this repo", {
    chatId: 9
  });

  assert.deepEqual(route, {
    target: "pty",
    prompt: "push this repo"
  });
});
