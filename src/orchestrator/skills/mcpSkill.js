import { suggestClosestWord } from "../../bot/commandUtils.js";

export class McpSkill {
  constructor({ mcpClient }) {
    this.mcpClient = mcpClient;
  }

  supports(text) {
    const normalized = text.trim().toLowerCase();
    return normalized.startsWith("/mcp") || normalized.includes("mcp ");
  }

  async execute({ text }) {
    if (!this.mcpClient.hasServers()) {
      return {
        text: "MCP server 未配置。请先在 .env 的 MCP_SERVERS 中添加服务定义。"
      };
    }

    const normalized = text.trim();
    if (normalized.startsWith("/mcp")) {
      return this.handleCommand(normalized);
    }

    return {
      text: "当前仅支持显式 MCP 命令。请使用 /mcp tools <server> 或 /mcp call <server> <tool> <jsonArgs>。"
    };
  }

  async handleCommand(rawText) {
    const stripped = rawText.replace(/^\/mcp(@\w+)?\s*/i, "").trim();
    const supportedSubcommands = ["list", "status", "reconnect", "enable", "disable", "tools", "call"];
    if (!stripped) {
      return {
        text: [
          "MCP 指令示例：",
          "/mcp list",
          "/mcp status [server]",
          "/mcp reconnect <server>",
          "/mcp enable <server>",
          "/mcp disable <server>",
          "/mcp tools <server>",
          '/mcp call <server> <tool> {"query":"hello"}'
        ].join("\n")
      };
    }

    const [subcommand, ...rest] = stripped.split(" ");
    if (subcommand === "list") {
      const servers = this.mcpClient.listServers();
      if (!servers.length) {
        return { text: "没有配置 MCP server。" };
      }

      return {
        text: [
          "MCP servers:",
          ...servers.map(
            (server) =>
              `- ${server.name}: ${server.enabled ? "enabled" : "disabled"}, ${server.connected ? "connected" : "disconnected"}`
          )
        ].join("\n")
      };
    }

    if (subcommand === "status") {
      const serverName = rest[0];
      const servers = this.mcpClient.listServers();
      const targets = serverName ? servers.filter((server) => server.name === serverName) : servers;

      if (!targets.length) {
        return { text: serverName ? `找不到 MCP server: ${serverName}` : "没有配置 MCP server。" };
      }

      return {
        text: targets
          .map(
            (server) =>
              [
                `server: ${server.name}`,
                `enabled: ${server.enabled ? "yes" : "no"}`,
                `connected: ${server.connected ? "yes" : "no"}`,
                `command: ${server.command}`,
                `args: ${server.args.length ? server.args.join(" ") : "(none)"}`,
                `cwd: ${server.cwd}`
              ].join("\n")
          )
          .join("\n\n")
      };
    }

    if (subcommand === "reconnect") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: "用法: /mcp reconnect <server>" };
      }

      const result = await this.mcpClient.reconnectServer(serverName);
      return {
        text: `${result.name} 已重连。enabled: ${result.enabled ? "yes" : "no"}, connected: ${result.connected ? "yes" : "no"}`
      };
    }

    if (subcommand === "enable") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: "用法: /mcp enable <server>" };
      }

      const result = await this.mcpClient.enableServer(serverName);
      return {
        text: `${result.name} 已启用。connected: ${result.connected ? "yes" : "no"}`
      };
    }

    if (subcommand === "disable") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: "用法: /mcp disable <server>" };
      }

      const result = await this.mcpClient.disableServer(serverName);
      return {
        text: `${result.name} 已禁用。connected: ${result.connected ? "yes" : "no"}`
      };
    }

    if (subcommand === "tools") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: "用法: /mcp tools <server>" };
      }

      const tools = await this.mcpClient.listTools(serverName);
      if (!tools.length) {
        return { text: `${serverName} 没有可用工具。` };
      }

      const lines = tools.map((tool) => `- ${tool.name}: ${tool.description || "No description"}`);
      return {
        text: [`${serverName} tools:`, ...lines].join("\n")
      };
    }

    if (subcommand === "call") {
      const serverName = rest[0];
      const toolName = rest[1];
      const jsonPart = rest.slice(2).join(" ").trim();

      if (!serverName || !toolName) {
        return { text: "用法: /mcp call <server> <tool> <jsonArgs>" };
      }

      let args = {};
      if (jsonPart) {
        try {
          args = JSON.parse(jsonPart);
        } catch (error) {
          return { text: `JSON 参数解析失败: ${error.message}` };
        }
      }

      const result = await this.mcpClient.callTool({
        serverName,
        toolName,
        args
      });

      return {
        text: result || "(empty MCP response)"
      };
    }

    const suggested = suggestClosestWord(subcommand, supportedSubcommands);
    return {
      text: suggested
        ? `未知 MCP 子命令: ${subcommand}。你是不是想输入 \`/mcp ${suggested}\`?`
        : `未知 MCP 子命令: ${subcommand}。支持: ${supportedSubcommands.join(", ")}。`
    };
  }
}
