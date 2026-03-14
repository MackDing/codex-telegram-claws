import test from "node:test";
import assert from "node:assert/strict";
import { McpClient } from "../src/orchestrator/mcpClient.js";

function createClient() {
  return new McpClient({
    mcp: {
      servers: [
        {
          name: "context7",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          cwd: process.cwd(),
          env: {}
        },
        {
          name: "sequential-thinking",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
          cwd: process.cwd(),
          env: {}
        }
      ]
    }
  });
}

function createConnection(
  onClose: () => Promise<void> = async () => {}
) {
  return {
    client: {
      connect: async () => {},
      listTools: async () => ({ tools: [] }),
      callTool: async () => ""
    },
    transport: {
      close: onClose
    }
  };
}

test("mcp client lists configured servers and their runtime state", () => {
  const client = createClient();
  client.connections.set("context7", createConnection());

  assert.deepEqual(
    client.listServers().map((server) => ({
      name: server.name,
      enabled: server.enabled,
      connected: server.connected
    })),
    [
      { name: "context7", enabled: true, connected: true },
      { name: "sequential-thinking", enabled: true, connected: false }
    ]
  );
});

test("mcp client disable and enable update runtime state", async () => {
  const client = createClient();
  let connectCalls = 0;
  client.connectServer = async (server) => {
    connectCalls += 1;
    client.connections.set(server.name, createConnection());
  };

  const disabled = await client.disableServer("context7");
  if (disabled === null) {
    throw new Error("Expected context7 disable result");
  }
  assert.equal(disabled.changed, true);
  assert.equal(client.isServerEnabled("context7"), false);
  assert.equal(client.isServerConnected("context7"), false);

  const enabled = await client.enableServer("context7");
  if (enabled === null) {
    throw new Error("Expected context7 enable result");
  }
  assert.equal(enabled.changed, true);
  assert.equal(client.isServerEnabled("context7"), true);
  assert.equal(client.isServerConnected("context7"), true);
  assert.equal(connectCalls, 1);
});

test("mcp client reconnect refreshes a known enabled server", async () => {
  const client = createClient();
  const closes: string[] = [];
  let connectCalls = 0;
  client.connections.set(
    "context7",
    createConnection(async () => {
      closes.push("context7");
    })
  );
  client.connectServer = async (server) => {
    connectCalls += 1;
    client.connections.set(server.name, createConnection());
  };

  const result = await client.reconnectServer("context7");
  if (result === null) {
    throw new Error("Expected context7 reconnect result");
  }

  assert.equal(result.name, "context7");
  assert.equal(result.connected, true);
  assert.deepEqual(closes, ["context7"]);
  assert.equal(connectCalls, 1);
});

test("mcp client exports and restores disabled server state", () => {
  const client = createClient();
  client.restoreState({
    disabledServers: ["sequential-thinking"]
  });

  assert.deepEqual(client.exportState(), {
    disabledServers: ["sequential-thinking"]
  });
  assert.equal(client.isServerEnabled("sequential-thinking"), false);
  assert.equal(client.isServerEnabled("context7"), true);
});

test("mcp client reports idempotent enable and disable operations", async () => {
  const client = createClient();
  client.connectServer = async (server) => {
    client.connections.set(server.name, createConnection());
  };
  client.connections.set("context7", createConnection());

  const enabled = await client.enableServer("context7");
  const disabled = await client.disableServer("context7");
  const disabledAgain = await client.disableServer("context7");

  if (enabled === null || disabled === null || disabledAgain === null) {
    throw new Error("Expected idempotent enable/disable results");
  }

  assert.equal(enabled.changed, false);
  assert.equal(disabled.changed, true);
  assert.equal(disabledAgain.changed, false);
});
