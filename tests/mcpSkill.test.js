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
