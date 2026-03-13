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

export function registerHandlers({ bot, router, ptyManager, skills, scheduler }) {
  bot.start(async (ctx) => {
    await sendChunkedMarkdown(
      ctx,
      [
        "codex-telegram-claws ready.",
        "普通消息和编码任务会路由到 Codex。",
        "MCP 只在显式 /mcp 命令下调用。",
        "试试: /status, /repo, /pwd, /exec, /auto, /plan, /model, /new",
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
        "/new - 新建会话并清空当前上下文",
        "/exec <task> - 强制用 codex exec 运行一次任务",
        "/auto <task> - 强制用 codex exec --full-auto 运行任务",
        "/plan <task> - 仅生成执行计划，不直接修改代码",
        "/model [name|reset] - 查看或设置当前 chat 的模型",
        "/interrupt - 向 Codex CLI 发送 Ctrl+C",
        "/stop - 终止当前 chat 的 PTY 会话",
        "/cron_now - 立即触发一次日报推送",
        "/gh ... - GitHub skill",
        "/mcp ... - MCP skill (显式调用)"
      ].join("\n")
    );
  });

  bot.command("status", async (ctx) => {
    const status = ptyManager.getStatus(ctx.chat.id);
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
        `mcp servers: ${status.mcpServers.length ? status.mcpServers.join(", ") : "none"}`
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
        `workdir: ${status.workdir}`
      ].join("\n")
    );
  });

  bot.command("repo", async (ctx) => {
    const payload = extractCommandPayload(ctx.message.text, "repo");
    if (!payload) {
      const status = ptyManager.getStatus(ctx.chat.id);
      const projects = ptyManager.listProjects();
      const lines = projects.map((project) => {
        const marker = project.path === status.workdir ? " <current>" : "";
        return `- ${project.relativePath}${marker}`;
      });

      await sendChunkedMarkdown(
        ctx,
        [
          `workspace root: ${status.workspaceRoot}`,
          "Available projects:",
          ...(lines.length ? lines : ["- (no git repos found under workspace root)"]),
          "",
          "Usage: /repo <name>"
        ].join("\n")
      );
      return;
    }

    try {
      const result = ptyManager.switchWorkdir(ctx.chat.id, payload);
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

  bot.command("new", async (ctx) => {
    const closed = ptyManager.closeSession(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      closed
        ? "当前会话已关闭。下一条消息会启动一个新的 Codex 会话。"
        : "当前没有活动会话。下一条消息会启动新的 Codex 会话。"
    );
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
    if (!text || text.startsWith("/")) return;

    try {
      const route = await router.routeMessage(text);
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
        ctx
      });
      await sendSkillResult(ctx, result);
    } catch (error) {
      await sendChunkedMarkdown(ctx, `处理消息失败: ${error.message}`);
    }
  });
}
