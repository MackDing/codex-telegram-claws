import { Markup } from "telegraf";
import { buildPlanPrompt, extractCommandPayload } from "./commandUtils.js";
import { escapeMarkdownV2, splitTelegramMessage } from "./formatter.js";

async function sendChunkedMarkdown(ctx, text, extra = {}) {
  const markdown = escapeMarkdownV2(text);
  const chunks = splitTelegramMessage(markdown, 3900);

  for (let i = 0; i < chunks.length; i += 1) {
    await ctx.reply(chunks[i], {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      ...extra
    });
  }
}

async function sendSkillResult(ctx, result) {
  const payload = typeof result === "string" ? { text: result } : result;
  const text = payload?.text || "(empty response)";
  const markdown = escapeMarkdownV2(text);
  const chunks = splitTelegramMessage(markdown, 3900);

  for (let i = 0; i < chunks.length; i += 1) {
    const maybeMarkup =
      i === chunks.length - 1 && payload.testJobId
        ? Markup.inlineKeyboard([
            Markup.button.callback("刷新测试状态", `gh:test_status:${payload.testJobId}`)
          ])
        : undefined;

    await ctx.reply(chunks[i], {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      ...(maybeMarkup ? maybeMarkup : {})
    });
  }
}

function formatProjectLines(projects, currentWorkdir) {
  return projects.map((project) => {
    const marker = project.path === currentWorkdir ? " <current>" : "";
    return `- ${project.relativePath}${marker}`;
  });
}

function formatSkillLines(skillStates) {
  return skillStates.map((skill) => `- ${skill.name}: ${skill.enabled ? "on" : "off"}`);
}

export function registerHandlers({
  bot,
  router,
  ptyManager,
  shellManager,
  skills,
  skillRegistry,
  scheduler,
  adminActions
}) {
  bot.start(async (ctx) => {
    await sendChunkedMarkdown(
      ctx,
      [
        "codex-telegram-claws ready.",
        "普通消息和编码任务会路由到 Codex。",
        "MCP 只在显式 /mcp 命令下调用。",
        "试试: /status, /repo, /pwd, /exec, /auto, /plan, /model, /skill, /new, /sh",
        "GitHub 指令示例: /gh commit \"feat: init\""
      ].join("\n")
    );
  });

  bot.command("help", async (ctx) => {
    await sendChunkedMarkdown(
      ctx,
      [
        "Commands:",
        "/help - 显示帮助",
        "/status - 查看当前 chat 的运行状态",
        "/pwd - 查看当前项目目录",
        "/repo - 列出可切换项目",
        "/repo <name> - 切换当前 chat 的项目",
        "/repo <keyword> - 关键词匹配项目并切换/列出候选",
        "/repo recent - 查看最近使用过的项目",
        "/repo - - 切回上一个项目",
        "/new - 新建会话并清空当前上下文",
        "/exec <task> - 强制用 codex exec 运行一次任务",
        "/auto <task> - 强制用 codex exec --full-auto 运行任务",
        "/plan <task> - 仅生成执行计划，不直接修改代码",
        "/model [name|reset] - 查看或设置当前 chat 的模型",
        "/skill list - 查看当前 chat 的 skill 开关",
        "/skill status - 同 /skill list",
        "/skill on <name> - 启用 skill",
        "/skill off <name> - 禁用 skill",
        "/sh <command> - 运行受限 Linux 命令 (默认关闭)",
        "/sh --confirm <command> - 确认执行高风险命令",
        "/restart - 重启 bot 进程",
        "/interrupt - 向 Codex CLI 发送 Ctrl+C",
        "/stop - 终止当前 chat 的 PTY 会话",
        "/cron_now - 立即触发一次日报推送",
        "/gh ... - GitHub skill",
        "/mcp ... - MCP skill 管理与显式调用"
      ].join("\n")
    );
  });

  bot.command("status", async (ctx) => {
    const status = ptyManager.getStatus(ctx.chat.id);
    const skillStates = skillRegistry.list(ctx.chat.id);
    const mcpServers = skills.mcp.mcpClient.listServers();
    await sendChunkedMarkdown(
      ctx,
      [
        "Status:",
        `active: ${status.active ? "yes" : "no"}`,
        `active mode: ${status.activeMode || "idle"}`,
        `last mode: ${status.lastMode || "none"}`,
        `last exit: ${status.lastExitCode === null ? "n/a" : status.lastExitCode}`,
        `pty supported: ${
          status.ptySupported === null ? "unknown" : status.ptySupported ? "yes" : "no (exec fallback)"
        }`,
        `preferred model: ${status.preferredModel || "inherit codex default"}`,
        `command: ${status.command}`,
        `workspace root: ${status.workspaceRoot}`,
        `workdir: ${status.workdir}`,
        `recent projects: ${ptyManager.getRecentProjects(ctx.chat.id).map((item) => item.relativePath).join(", ") || "."}`,
        `project context: ${status.projectSessionId ? `resumable (${status.projectSessionId})` : "fresh"}`,
        `safe shell: ${
          shellManager.isEnabled()
            ? `enabled, ${shellManager.isReadOnly() ? "read-only" : "writable"} (${shellManager.getAllowedCommands().length} prefixes)`
            : "disabled"
        }`,
        `skills: ${skillStates.map((skill) => `${skill.name}:${skill.enabled ? "on" : "off"}`).join(", ") || "none"}`,
        `mcp servers: ${
          mcpServers.length
            ? mcpServers.map((server) => `${server.name}:${server.enabled ? "on" : "off"}/${server.connected ? "up" : "down"}`).join(", ")
            : "none"
        }`
      ].join("\n")
    );
  });

  bot.command("pwd", async (ctx) => {
    const status = ptyManager.getStatus(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      [
        `workspace root: ${status.workspaceRoot}`,
        `current project: ${status.relativeWorkdir}`,
        `workdir: ${status.workdir}`,
        `recent: ${ptyManager.getRecentProjects(ctx.chat.id).map((item) => item.relativePath).join(", ") || "."}`
      ].join("\n")
    );
  });

  bot.command("repo", async (ctx) => {
    const payload = extractCommandPayload(ctx.message.text, "repo");
    const status = ptyManager.getStatus(ctx.chat.id);

    if (!payload) {
      const projects = ptyManager.listProjects();
      const recent = ptyManager.getRecentProjects(ctx.chat.id);
      const lines = formatProjectLines(projects, status.workdir);
      const recentLines = recent.map((project) => `- ${project.relativePath}`);

      await sendChunkedMarkdown(
        ctx,
        [
          `workspace root: ${status.workspaceRoot}`,
          "Available projects:",
          ...(lines.length ? lines : ["- (no git repos found under workspace root)"]),
          "",
          "Recent projects:",
          ...(recentLines.length ? recentLines : ["- ."]),
          "",
          "Usage: /repo <name> | /repo recent | /repo -"
        ].join("\n")
      );
      return;
    }

    if (/^recent$/i.test(payload)) {
      const recent = ptyManager.getRecentProjects(ctx.chat.id).map((project) => `- ${project.relativePath}`);
      await sendChunkedMarkdown(
        ctx,
        [
          "Recent projects:",
          ...(recent.length ? recent : ["- ."]),
          "",
          "Use /repo <name> to switch."
        ].join("\n")
      );
      return;
    }

    try {
      let target = payload;
      if (payload !== "-") {
        const projects = ptyManager.listProjects();
        const exact = projects.find(
          (project) => project.relativePath === payload || project.name === payload
        );

        if (!exact) {
          const lowerPayload = payload.toLowerCase();
          const matches = projects.filter((project) =>
            project.relativePath.toLowerCase().includes(lowerPayload)
          );

          if (!matches.length) {
            throw new Error(`没有匹配的项目: ${payload}`);
          }

          if (matches.length > 1) {
            await sendChunkedMarkdown(
              ctx,
              [
                `找到多个匹配项目: ${payload}`,
                ...formatProjectLines(matches, status.workdir),
                "",
                "请使用更精确的名称。"
              ].join("\n")
            );
            return;
          }

          target = matches[0].relativePath;
        }
      }

      const result =
        target === "-"
          ? ptyManager.switchToPreviousWorkdir(ctx.chat.id)
          : ptyManager.switchWorkdir(ctx.chat.id, target);
      await sendChunkedMarkdown(
        ctx,
        [
          "Project switched.",
          `current project: ${result.relativePath}`,
          `workdir: ${result.workdir}`
        ].join("\n")
      );
    } catch (error) {
      await sendChunkedMarkdown(ctx, `切换项目失败: ${error.message}`);
    }
  });

  bot.command("skill", async (ctx) => {
    const payload = extractCommandPayload(ctx.message.text, "skill");
    if (!payload || /^(list|status)$/i.test(payload)) {
      await sendChunkedMarkdown(
        ctx,
        [
          "Skills:",
          ...formatSkillLines(skillRegistry.list(ctx.chat.id)),
          "",
          "Usage: /skill list | /skill on <name> | /skill off <name>"
        ].join("\n")
      );
      return;
    }

    const [action, rawName] = payload.split(/\s+/, 2);
    if (!/^(on|off)$/i.test(action) || !rawName) {
      await sendChunkedMarkdown(ctx, "用法: /skill list | /skill on <name> | /skill off <name>");
      return;
    }

    try {
      const actionResult = /^on$/i.test(action)
        ? skillRegistry.enable(ctx.chat.id, rawName)
        : skillRegistry.disable(ctx.chat.id, rawName);
      if (/^on$/i.test(action)) {
        await sendChunkedMarkdown(
          ctx,
          [
            actionResult.changed
              ? `skill ${rawName} 已启用。`
              : `skill ${rawName} 已处于启用状态。`,
            ...formatSkillLines(actionResult.skills)
          ].join("\n")
        );
        return;
      }

      await sendChunkedMarkdown(
        ctx,
        [
          actionResult.changed
            ? `skill ${rawName} 已禁用。`
            : `skill ${rawName} 已处于禁用状态。`,
          ...formatSkillLines(actionResult.skills)
        ].join("\n")
      );
    } catch (error) {
      await sendChunkedMarkdown(ctx, `Skill 管理失败: ${error.message}`);
    }
  });

  bot.command("new", async (ctx) => {
    const result = ptyManager.resetCurrentProjectConversation(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      result.closed
        ? "当前项目的会话上下文已清空，并关闭了活动会话。下一条消息会在当前项目启动全新 Codex 会话。"
        : "当前项目的会话上下文已清空。下一条消息会在当前项目启动全新 Codex 会话。"
    );
  });

  bot.command("restart", async (ctx) => {
    if (!adminActions?.restart) {
      await sendChunkedMarkdown(ctx, "当前环境未启用 bot 重启控制。");
      return;
    }

    await sendChunkedMarkdown(ctx, "正在重启 bot 进程...");
    await adminActions.restart();
  });

  bot.command("exec", async (ctx) => {
    const task = extractCommandPayload(ctx.message.text, "exec");
    if (!task) {
      await sendChunkedMarkdown(ctx, "用法: /exec <task>");
      return;
    }

    const result = await ptyManager.sendPrompt(ctx, task, {
      forceExec: true,
      notice: "Running one-off `codex exec` task..."
    });

    if (!result.started) {
      await sendChunkedMarkdown(
        ctx,
        `当前已有 ${result.activeMode || "unknown"} 任务在运行。请等待完成或先使用 /interrupt。`
      );
    }
  });

  bot.command("sh", async (ctx) => {
    const command = extractCommandPayload(ctx.message.text, "sh");
    if (!command) {
      await sendChunkedMarkdown(ctx, "用法: /sh <command>");
      return;
    }

    const status = ptyManager.getStatus(ctx.chat.id);
    if (status.active) {
      await sendChunkedMarkdown(ctx, "当前有 Codex 任务正在运行。先等待完成，或使用 /interrupt /new。");
      return;
    }

    let validation;
    try {
      validation = shellManager.inspectCommand(command);
    } catch (error) {
      await sendChunkedMarkdown(ctx, error.message);
      return;
    }

    if (validation.requiresConfirmation) {
      await sendChunkedMarkdown(
        ctx,
        [
          "该命令被标记为高风险，需要二次确认。",
          `command: ${validation.commandText}`,
          `confirm with: ${validation.confirmationCommand}`
        ].join("\n")
      );
      return;
    }

    await sendChunkedMarkdown(
      ctx,
      [
        "Running safe shell command...",
        `workdir: ${status.workdir}`,
        `command: ${validation.argv.join(" ")}`
      ].join("\n")
    );

    const result = await shellManager.execute({
      chatId: ctx.chat.id,
      rawCommand: command,
      workdir: status.workdir
    });

    if (!result.started) {
      await sendChunkedMarkdown(ctx, "当前 chat 已有一个 shell 命令在运行。");
      return;
    }

    await sendChunkedMarkdown(
      ctx,
      [
        `shell status: ${result.status}`,
        `command: ${result.command}`,
        `workdir: ${result.workdir}`,
        `exitCode: ${result.exitCode === null ? "n/a" : result.exitCode}`,
        `signal: ${result.signal || "none"}`,
        "",
        "output:",
        result.output
      ].join("\n")
    );
  });

  bot.command("auto", async (ctx) => {
    const task = extractCommandPayload(ctx.message.text, "auto");
    if (!task) {
      await sendChunkedMarkdown(ctx, "用法: /auto <task>");
      return;
    }

    const result = await ptyManager.sendPrompt(ctx, task, {
      forceExec: true,
      fullAuto: true,
      notice: "Running one-off `codex exec --full-auto` task..."
    });

    if (!result.started) {
      await sendChunkedMarkdown(
        ctx,
        `当前已有 ${result.activeMode || "unknown"} 任务在运行。请等待完成或先使用 /interrupt。`
      );
    }
  });

  bot.command("plan", async (ctx) => {
    const task = extractCommandPayload(ctx.message.text, "plan");
    if (!task) {
      await sendChunkedMarkdown(ctx, "用法: /plan <task>");
      return;
    }

    const result = await ptyManager.sendPrompt(ctx, buildPlanPrompt(task), {
      forceExec: true,
      notice: "Running planning-only Codex task..."
    });

    if (!result.started) {
      await sendChunkedMarkdown(
        ctx,
        `当前已有 ${result.activeMode || "unknown"} 任务在运行。请等待完成或先使用 /interrupt。`
      );
    }
  });

  bot.command("model", async (ctx) => {
    const value = extractCommandPayload(ctx.message.text, "model");
    if (!value) {
      const status = ptyManager.getStatus(ctx.chat.id);
      await sendChunkedMarkdown(
        ctx,
        `当前模型: ${status.preferredModel || "inherit codex default"}`
      );
      return;
    }

    if (/^(reset|default|inherit)$/i.test(value)) {
      ptyManager.clearPreferredModel(ctx.chat.id);
      const closed = ptyManager.closeSession(ctx.chat.id);
      await sendChunkedMarkdown(
        ctx,
        closed
          ? "模型已重置为 Codex 默认值，并重建了当前会话。"
          : "模型已重置为 Codex 默认值。"
      );
      return;
    }

    ptyManager.setPreferredModel(ctx.chat.id, value);
    const closed = ptyManager.closeSession(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      closed
        ? `模型已设置为 ${value}，并重建了当前会话。`
        : `模型已设置为 ${value}。`
    );
  });

  bot.command("interrupt", async (ctx) => {
    const ok = ptyManager.interrupt(ctx.chat.id);
    await sendChunkedMarkdown(ctx, ok ? "已发送 Ctrl+C。" : "当前 chat 没有活动 PTY 会话。");
  });

  bot.command("stop", async (ctx) => {
    const ok = ptyManager.closeSession(ctx.chat.id);
    await sendChunkedMarkdown(ctx, ok ? "PTY 会话已终止。" : "当前 chat 没有活动 PTY 会话。");
  });

  bot.command("cron_now", async (ctx) => {
    try {
      await scheduler.triggerDailySummaryNow(ctx.from.id);
      await sendChunkedMarkdown(ctx, "日报已触发并推送。");
    } catch (error) {
      await sendChunkedMarkdown(ctx, `触发失败: ${error.message}`);
    }
  });

  bot.command("gh", async (ctx) => {
    if (!skillRegistry.isEnabled(ctx.chat.id, "github")) {
      await sendChunkedMarkdown(ctx, "GitHub skill 当前 chat 已禁用。使用 /skill on github 重新启用。");
      return;
    }

    try {
      const text = extractCommandPayload(ctx.message.text, "gh") || "help";
      const result = await skills.github.execute({
        text: `/gh ${text}`,
        ctx,
        workdir: ptyManager.getStatus(ctx.chat.id).workdir
      });
      await sendSkillResult(ctx, result);
    } catch (error) {
      await sendChunkedMarkdown(ctx, `GitHub skill 执行失败: ${error.message}`);
    }
  });

  bot.command("mcp", async (ctx) => {
    if (!skillRegistry.isEnabled(ctx.chat.id, "mcp")) {
      await sendChunkedMarkdown(ctx, "MCP skill 当前 chat 已禁用。使用 /skill on mcp 重新启用。");
      return;
    }

    try {
      const text = ctx.message.text.trim();
      const result = await skills.mcp.execute({ text, ctx });
      await sendSkillResult(ctx, result);
    } catch (error) {
      await sendChunkedMarkdown(ctx, `MCP skill 执行失败: ${error.message}`);
    }
  });

  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("gh:test_status:")) return;

    const jobId = data.replace("gh:test_status:", "");
    const result = await skills.github.getTestStatus(jobId);
    await ctx.answerCbQuery("状态已刷新");

    if (!result) {
      await sendChunkedMarkdown(ctx, `找不到测试任务: ${jobId}`);
      return;
    }

    await sendSkillResult(ctx, result);
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message.text?.trim() || "";
    if (!text) return;
    if (/^(重启\s*bot|重启机器人|restart bot)$/i.test(text)) {
      await sendChunkedMarkdown(ctx, "请使用 /restart，而不是把它当作普通消息发送。");
      return;
    }
    if (/^\/\s+\S+/.test(text)) {
      await sendChunkedMarkdown(
        ctx,
        [
          "命令格式错误：`/` 后面不要加空格。",
          `try: ${text.replace(/^\/\s+/, "/")}`
        ].join("\n")
      );
      return;
    }
    if (text.startsWith("/")) return;

    try {
      const route = await router.routeMessage(text, {
        chatId: ctx.chat.id
      });
      if (route.target === "pty") {
        const result = await ptyManager.sendPrompt(ctx, route.prompt);
        if (!result.started) {
          await sendChunkedMarkdown(
            ctx,
            `当前已有 ${result.activeMode || "unknown"} 任务在运行。请等待完成或先使用 /interrupt。`
          );
        }
        return;
      }

      const skill = skills[route.skill];
      if (!skill) {
        await sendChunkedMarkdown(ctx, `未找到 skill: ${route.skill}`);
        return;
      }

      const result = await skill.execute({
        text: route.payload,
        ctx,
        workdir: ptyManager.getStatus(ctx.chat.id).workdir
      });
      await sendSkillResult(ctx, result);
    } catch (error) {
      await sendChunkedMarkdown(ctx, `处理消息失败: ${error.message}`);
    }
  });
}
