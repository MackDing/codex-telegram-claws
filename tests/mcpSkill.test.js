import test from "node:test";
import assert from "node:assert/strict";
import { McpSkill } from "../src/orchestrator/skills/mcpSkill.js";

function createSkill() {
  return new McpSkill({
    mcpClient: {
      hasServers: () => true,
      listServers: () => [
        {
          name: "context7",
          enabled: true,
          connected: true,
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          cwd: process.cwd()
        }
      ],
      reconnectServer: async (name) => ({
        name,
        enabled: true,
        connected: true
      }),
      enableServer: async (name) => ({
        name,
        enabled: true,
        connected: true
      }),
      disableServer: async (name) => ({
        name,
        enabled: false,
        connected: false
      }),
      listTools: async () => [],
      callTool: async () => ""
    }
  });
}

test("mcp skill suggests the closest subcommand for small typos", async () => {
  const skill = createSkill();
  const result = await skill.execute({
    text: "/mcp ststus"
  });

  assert.match(result.text, /\/mcp status/);
});

test("mcp skill returns expanded help text when no subcommand is provided", async () => {
  const skill = createSkill();
  const result = await skill.execute({
    text: "/mcp"
  });

  assert.match(result.text, /\/mcp list/);
  assert.match(result.text, /\/mcp status \[server\]/);
});

test("mcp skill returns idempotent enable feedback", async () => {
  const skill = new McpSkill({
    mcpClient: {
      hasServers: () => true,
      listServers: () => [],
      reconnectServer: async () => null,
      enableServer: async (name) => ({
        name,
        enabled: true,
        connected: true,
        changed: false
      }),
      disableServer: async () => null,
      listTools: async () => [],
      callTool: async () => ""
    }
  });

  const result = await skill.execute({
    text: "/mcp enable context7"
  });

  assert.match(result.text, /already enabled/);
});

test("mcp skill localizes output when locale is zh", async () => {
  const skill = createSkill();
  const result = await skill.execute({
    text: "/mcp",
    locale: "zh"
  });

  assert.match(result.text, /MCP 指令示例/);
});
