import { suggestClosestWord } from "../../bot/commandUtils.js";
import { t, type Locale } from "../../bot/i18n.js";

interface McpServerState {
  name: string;
  enabled: boolean;
  connected: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
}

interface McpToolDefinition {
  name?: string;
  description?: string;
}

interface McpClientLike {
  hasServers(): boolean;
  listServers(): McpServerState[];
  reconnectServer(name: string): Promise<unknown>;
  enableServer(name: string): Promise<unknown>;
  disableServer(name: string): Promise<unknown>;
  listTools(serverName: string): Promise<McpToolDefinition[]>;
  callTool(args: {
    serverName: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<string>;
}

interface SkillExecutionInput {
  text: string;
  locale?: Locale;
}

export interface SkillExecutionResult {
  text: string;
  testJobId?: string;
}

export class McpSkill {
  readonly mcpClient: McpClientLike;

  constructor({ mcpClient }: { mcpClient: McpClientLike }) {
    this.mcpClient = mcpClient;
  }

  supports(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return normalized.startsWith("/mcp") || normalized.includes("mcp ");
  }

  async execute({
    text,
    locale = "en"
  }: SkillExecutionInput): Promise<SkillExecutionResult> {
    if (!this.mcpClient.hasServers()) {
      return {
        text: t(locale, "mcpServerNotConfigured")
      };
    }

    const normalized = text.trim();
    if (normalized.startsWith("/mcp")) {
      return this.handleCommand(normalized, locale);
    }

    return {
      text: t(locale, "mcpExplicitOnly")
    };
  }

  async handleCommand(
    rawText: string,
    locale: Locale = "en"
  ): Promise<SkillExecutionResult> {
    const stripped = rawText.replace(/^\/mcp(@\w+)?\s*/i, "").trim();
    const supportedSubcommands = [
      "list",
      "status",
      "reconnect",
      "enable",
      "disable",
      "tools",
      "call"
    ];
    if (!stripped) {
      return {
        text: t(locale, "mcpHelp")
      };
    }

    const [subcommand = "", ...rest] = stripped.split(" ");
    if (subcommand === "list") {
      const servers = this.mcpClient.listServers();
      if (!servers.length) {
        return { text: t(locale, "mcpNoServers") };
      }

      return {
        text: t(locale, "mcpList", { servers })
      };
    }

    if (subcommand === "status") {
      const serverName = rest[0];
      const servers = this.mcpClient.listServers();
      const targets = serverName
        ? servers.filter((server) => server.name === serverName)
        : servers;

      if (!targets.length) {
        return {
          text: serverName
            ? t(locale, "mcpUnknownServer", { name: serverName })
            : t(locale, "mcpNoServers")
        };
      }

      return {
        text: t(locale, "mcpStatus", { servers: targets })
      };
    }

    if (subcommand === "reconnect") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: t(locale, "mcpUsageReconnect") };
      }

      const result = await this.mcpClient.reconnectServer(serverName);
      return {
        text: t(locale, "mcpReconnected", { result })
      };
    }

    if (subcommand === "enable") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: t(locale, "mcpUsageEnable") };
      }

      const result = await this.mcpClient.enableServer(serverName);
      return {
        text: t(locale, "mcpEnableResult", { result })
      };
    }

    if (subcommand === "disable") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: t(locale, "mcpUsageDisable") };
      }

      const result = await this.mcpClient.disableServer(serverName);
      return {
        text: t(locale, "mcpDisableResult", { result })
      };
    }

    if (subcommand === "tools") {
      const serverName = rest[0];
      if (!serverName) {
        return { text: t(locale, "mcpUsageTools") };
      }

      const tools = await this.mcpClient.listTools(serverName);
      if (!tools.length) {
        return { text: t(locale, "mcpNoTools", { server: serverName }) };
      }

      const lines = tools.map(
        (tool) => `- ${tool.name}: ${tool.description || "No description"}`
      );
      return {
        text: t(locale, "mcpTools", { server: serverName, lines })
      };
    }

    if (subcommand === "call") {
      const serverName = rest[0];
      const toolName = rest[1];
      const jsonPart = rest.slice(2).join(" ").trim();

      if (!serverName || !toolName) {
        return { text: t(locale, "mcpUsageCall") };
      }

      let args = {};
      if (jsonPart) {
        try {
          args = JSON.parse(jsonPart) as Record<string, unknown>;
        } catch (error: unknown) {
          return {
            text: t(locale, "mcpJsonParseFailed", {
              error: error instanceof Error ? error.message : String(error)
            })
          };
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
      text: t(locale, "mcpUnknownSubcommand", {
        subcommand,
        suggested,
        supported: supportedSubcommands
      })
    };
  }
}
