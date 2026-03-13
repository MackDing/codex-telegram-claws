import { Markup } from "telegraf";
import {
  buildPlanPrompt,
  extractCommandPayload,
  suggestClosestWord
} from "./commandUtils.js";
import { normalizeLanguage, SUPPORTED_LANGUAGES, t } from "./i18n.js";
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

async function sendSkillResult(ctx, result, locale = "en") {
  const payload = typeof result === "string" ? { text: result } : result;
  const text = payload?.text || t(locale, "emptyResponse");
  const markdown = escapeMarkdownV2(text);
  const chunks = splitTelegramMessage(markdown, 3900);

  for (let i = 0; i < chunks.length; i += 1) {
    const maybeMarkup =
      i === chunks.length - 1 && payload.testJobId
        ? Markup.inlineKeyboard([
            Markup.button.callback(
              t(locale, "buttonRefreshTestStatus"),
              `gh:test_status:${payload.testJobId}`
            )
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

function suggestProjectName(input, projects) {
  const candidates = [
    ...new Set(
      projects.flatMap((project) => [project.relativePath, project.name]).filter(Boolean)
    )
  ];

  const threshold = Math.min(
    6,
    Math.max(2, Math.ceil(String(input || "").trim().length * 0.35))
  );

  return suggestClosestWord(input, candidates, threshold);
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
  const localeOf = (chatId) => ptyManager.getLanguage(chatId);

  bot.start(async (ctx) => {
    await sendChunkedMarkdown(ctx, t(localeOf(ctx.chat.id), "startLines").join("\n"));
  });

  bot.command("help", async (ctx) => {
    await sendChunkedMarkdown(ctx, t(localeOf(ctx.chat.id), "helpLines").join("\n"));
  });

  bot.command("status", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const status = ptyManager.getStatus(ctx.chat.id);
    const skillStates = skillRegistry.list(ctx.chat.id);
    const mcpServers = skills.mcp.mcpClient.listServers();
    const shellSummary = shellManager.isEnabled()
      ? `enabled, ${shellManager.isReadOnly() ? "read-only" : "writable"} (${shellManager.getAllowedCommands().length} prefixes)`
      : "disabled";
    const skillsSummary =
      skillStates.map((skill) => `${skill.name}:${skill.enabled ? "on" : "off"}`).join(", ") || "none";
    const mcpSummary = mcpServers.length
      ? mcpServers
          .map((server) => `${server.name}:${server.enabled ? "on" : "off"}/${server.connected ? "up" : "down"}`)
          .join(", ")
      : "none";
    await sendChunkedMarkdown(
      ctx,
      t(locale, "statusLines", {
        status,
        recentProjects:
          ptyManager.getRecentProjects(ctx.chat.id).map((item) => item.relativePath).join(", ") || ".",
        shellSummary,
        skillsSummary,
        mcpSummary
      }).join("\n")
    );
  });

  bot.command("pwd", async (ctx) => {
    const status = ptyManager.getStatus(ctx.chat.id);
    await sendChunkedMarkdown(
      ctx,
      t(localeOf(ctx.chat.id), "pwdLines", {
        status,
        recent: ptyManager.getRecentProjects(ctx.chat.id).map((item) => item.relativePath).join(", ") || "."
      }).join("\n")
    );
  });

  bot.command("repo", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const payload = extractCommandPayload(ctx.message.text, "repo");
    const status = ptyManager.getStatus(ctx.chat.id);

    if (!payload) {
      const projects = ptyManager.listProjects();
      const recent = ptyManager.getRecentProjects(ctx.chat.id);
      const lines = formatProjectLines(projects, status.workdir);
      const recentLines = recent.map((project) => `- ${project.relativePath}`);

      await sendChunkedMarkdown(
        ctx,
        t(locale, "repoList", {
          workspaceRoot: status.workspaceRoot,
          projectLines: lines,
          recentLines
        })
      );
      return;
    }

    if (/^recent$/i.test(payload)) {
      const recent = ptyManager.getRecentProjects(ctx.chat.id).map((project) => `- ${project.relativePath}`);
      await sendChunkedMarkdown(
        ctx,
        t(locale, "repoRecent", {
          recentLines: recent
        })
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
            const suggestion = suggestProjectName(payload, projects);
            if (suggestion) {
              throw new Error(t(locale, "repoSuggestion", { value: payload, suggestion }));
            }

            throw new Error(t(locale, "repoNoMatch", { value: payload }));
          }

          if (matches.length > 1) {
            await sendChunkedMarkdown(
              ctx,
              t(locale, "repoMultipleMatches", {
                value: payload,
                projectLines: formatProjectLines(matches, status.workdir)
              })
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
        t(locale, "repoSwitched", {
          relativePath: result.relativePath,
          workdir: result.workdir
        })
      );
    } catch (error) {
      await sendChunkedMarkdown(ctx, t(locale, "repoSwitchFailed", { error: error.message }));
    }
  });

  bot.command("skill", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const payload = extractCommandPayload(ctx.message.text, "skill");
    if (!payload || /^(list|status)$/i.test(payload)) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "skillList", {
          skillLines: formatSkillLines(skillRegistry.list(ctx.chat.id))
        })
      );
      return;
    }

    const [action, rawName] = payload.split(/\s+/, 2);
    if (!/^(on|off)$/i.test(action) || !rawName) {
      await sendChunkedMarkdown(ctx, t(locale, "skillUsage"));
      return;
    }

    try {
      const actionResult = /^on$/i.test(action)
        ? skillRegistry.enable(ctx.chat.id, rawName)
        : skillRegistry.disable(ctx.chat.id, rawName);
      if (/^on$/i.test(action)) {
        await sendChunkedMarkdown(
          ctx,
          t(locale, "skillStateChanged", {
            name: rawName,
            enabled: true,
            changed: actionResult.changed,
            skillLines: formatSkillLines(actionResult.skills)
          })
        );
        return;
      }

      await sendChunkedMarkdown(
        ctx,
        t(locale, "skillStateChanged", {
          name: rawName,
          enabled: false,
          changed: actionResult.changed,
          skillLines: formatSkillLines(actionResult.skills)
        })
      );
    } catch (error) {
      await sendChunkedMarkdown(ctx, t(locale, "skillManagementFailed", { error: error.message }));
    }
  });

  bot.command("new", async (ctx) => {
    const result = ptyManager.resetCurrentProjectConversation(ctx.chat.id);
    await sendChunkedMarkdown(ctx, t(localeOf(ctx.chat.id), "conversationReset", { closed: result.closed }));
  });

  bot.command("restart", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    if (!adminActions?.restart) {
      await sendChunkedMarkdown(ctx, t(locale, "restartUnavailable"));
      return;
    }

    await sendChunkedMarkdown(ctx, t(locale, "restarting"));
    await adminActions.restart();
  });

  bot.command("exec", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const task = extractCommandPayload(ctx.message.text, "exec");
    if (!task) {
      await sendChunkedMarkdown(ctx, t(locale, "usageExec"));
      return;
    }

    const result = await ptyManager.sendPrompt(ctx, task, {
      forceExec: true,
      notice: t(locale, "execNotice")
    });

    if (!result.started) {
      await sendChunkedMarkdown(ctx, t(locale, "taskBusy", { mode: result.activeMode || "unknown" }));
    }
  });

  bot.command("sh", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const command = extractCommandPayload(ctx.message.text, "sh");
    if (!command) {
      await sendChunkedMarkdown(ctx, t(locale, "usageSh"));
      return;
    }

    const status = ptyManager.getStatus(ctx.chat.id);
    if (status.active) {
      await sendChunkedMarkdown(ctx, t(locale, "codexBusyForShell"));
      return;
    }

    let validation;
    try {
      validation = shellManager.inspectCommand(command, { locale });
    } catch (error) {
      await sendChunkedMarkdown(ctx, error.message);
      return;
    }

    if (validation.requiresConfirmation) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "shellRequiresConfirmation", {
          command: validation.commandText,
          confirmationCommand: validation.confirmationCommand
        })
      );
      return;
    }

    await sendChunkedMarkdown(
      ctx,
      t(locale, "runningSafeShell", {
        workdir: status.workdir,
        command: validation.argv.join(" ")
      })
    );

    const result = await shellManager.execute({
      chatId: ctx.chat.id,
      rawCommand: command,
      workdir: status.workdir,
      locale
    });

    if (!result.started) {
      await sendChunkedMarkdown(ctx, t(locale, "shellBusy"));
      return;
    }

    await sendChunkedMarkdown(ctx, t(locale, "shellResult", { result }));
  });

  bot.command("auto", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const task = extractCommandPayload(ctx.message.text, "auto");
    if (!task) {
      await sendChunkedMarkdown(ctx, t(locale, "usageAuto"));
      return;
    }

    const result = await ptyManager.sendPrompt(ctx, task, {
      forceExec: true,
      fullAuto: true,
      notice: t(locale, "autoNotice")
    });

    if (!result.started) {
      await sendChunkedMarkdown(ctx, t(locale, "taskBusy", { mode: result.activeMode || "unknown" }));
    }
  });

  bot.command("plan", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const task = extractCommandPayload(ctx.message.text, "plan");
    if (!task) {
      await sendChunkedMarkdown(ctx, t(locale, "usagePlan"));
      return;
    }

    const result = await ptyManager.sendPrompt(ctx, buildPlanPrompt(task), {
      forceExec: true,
      notice: t(locale, "planNotice")
    });

    if (!result.started) {
      await sendChunkedMarkdown(ctx, t(locale, "taskBusy", { mode: result.activeMode || "unknown" }));
    }
  });

  bot.command("model", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const value = extractCommandPayload(ctx.message.text, "model");
    if (!value) {
      const status = ptyManager.getStatus(ctx.chat.id);
      await sendChunkedMarkdown(ctx, t(locale, "modelCurrent", { model: status.preferredModel }));
      return;
    }

    if (/^(reset|default|inherit)$/i.test(value)) {
      ptyManager.clearPreferredModel(ctx.chat.id);
      const closed = ptyManager.closeSession(ctx.chat.id);
      await sendChunkedMarkdown(ctx, t(locale, "modelReset", { closed }));
      return;
    }

    ptyManager.setPreferredModel(ctx.chat.id, value);
    const closed = ptyManager.closeSession(ctx.chat.id);
    await sendChunkedMarkdown(ctx, t(locale, "modelSet", { value, closed }));
  });

  bot.command("verbose", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const value = extractCommandPayload(ctx.message.text, "verbose");
    if (!value) {
      await sendChunkedMarkdown(ctx, t(locale, "verboseCurrent", { enabled: ptyManager.isVerbose(ctx.chat.id) }));
      return;
    }

    if (/^(on|true|1)$/i.test(value)) {
      ptyManager.setVerbose(ctx.chat.id, true);
      await sendChunkedMarkdown(ctx, t(locale, "verboseSet", { enabled: true }));
      return;
    }

    if (/^(off|false|0)$/i.test(value)) {
      ptyManager.setVerbose(ctx.chat.id, false);
      await sendChunkedMarkdown(ctx, t(locale, "verboseSet", { enabled: false }));
      return;
    }

    await sendChunkedMarkdown(ctx, t(locale, "usageVerbose"));
  });

  bot.command("language", async (ctx) => {
    const currentLocale = localeOf(ctx.chat.id);
    const value = extractCommandPayload(ctx.message.text, "language");
    if (!value) {
      await sendChunkedMarkdown(
        ctx,
        t(currentLocale, "languageCurrent", {
          language: currentLocale
        })
      );
      return;
    }

    const normalized = normalizeLanguage(value);
    if (!SUPPORTED_LANGUAGES.includes(normalized)) {
      await sendChunkedMarkdown(ctx, t(currentLocale, "languageInvalid"));
      return;
    }

    ptyManager.setLanguage(ctx.chat.id, normalized);
    await sendChunkedMarkdown(
      ctx,
      t(normalized, "languageSet", {
        language: normalized
      })
    );
  });

  bot.command("interrupt", async (ctx) => {
    const ok = ptyManager.interrupt(ctx.chat.id);
    await sendChunkedMarkdown(ctx, t(localeOf(ctx.chat.id), "interruptResult", { ok }));
  });

  bot.command("stop", async (ctx) => {
    const ok = ptyManager.closeSession(ctx.chat.id);
    await sendChunkedMarkdown(ctx, t(localeOf(ctx.chat.id), "stopResult", { ok }));
  });

  bot.command("cron_now", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    try {
      await scheduler.triggerDailySummaryNow(ctx.from.id);
      await sendChunkedMarkdown(ctx, t(locale, "cronTriggered"));
    } catch (error) {
      await sendChunkedMarkdown(ctx, t(locale, "triggerFailed", { error: error.message }));
    }
  });

  bot.command("gh", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    if (!skillRegistry.isEnabled(ctx.chat.id, "github")) {
      await sendChunkedMarkdown(ctx, t(locale, "githubDisabled"));
      return;
    }

    try {
      const text = extractCommandPayload(ctx.message.text, "gh") || "help";
      const result = await skills.github.execute({
        text: `/gh ${text}`,
        ctx,
        workdir: ptyManager.getStatus(ctx.chat.id).workdir,
        locale
      });
      await sendSkillResult(ctx, result, locale);
    } catch (error) {
      await sendChunkedMarkdown(ctx, t(locale, "githubFailed", { error: error.message }));
    }
  });

  bot.command("mcp", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    if (!skillRegistry.isEnabled(ctx.chat.id, "mcp")) {
      await sendChunkedMarkdown(ctx, t(locale, "mcpDisabled"));
      return;
    }

    try {
      const text = ctx.message.text.trim();
      const result = await skills.mcp.execute({ text, ctx, locale });
      await sendSkillResult(ctx, result, locale);
    } catch (error) {
      await sendChunkedMarkdown(ctx, t(locale, "mcpFailed", { error: error.message }));
    }
  });

  bot.on("callback_query", async (ctx) => {
    const locale = localeOf(ctx.chat.id);
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("gh:test_status:")) return;

    const jobId = data.replace("gh:test_status:", "");
    const result = await skills.github.getTestStatus(jobId, locale);
    await ctx.answerCbQuery(t(locale, "callbackRefreshed"));

    if (!result) {
      await sendChunkedMarkdown(ctx, t(locale, "testJobNotFound", { jobId }));
      return;
    }

    await sendSkillResult(ctx, result, locale);
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message.text?.trim() || "";
    const locale = localeOf(ctx.chat.id);
    if (!text) return;
    if (/^(重启\s*bot|重启机器人|restart bot)$/i.test(text)) {
      await sendChunkedMarkdown(ctx, t(locale, "useRestartCommand"));
      return;
    }
    if (/^\/\s+\S+/.test(text)) {
      await sendChunkedMarkdown(
        ctx,
        t(locale, "slashSpaceError", {
          fixed: text.replace(/^\/\s+/, "/")
        })
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
          await sendChunkedMarkdown(ctx, t(locale, "taskBusy", { mode: result.activeMode || "unknown" }));
        }
        return;
      }

      const skill = skills[route.skill];
      if (!skill) {
        await sendChunkedMarkdown(ctx, t(locale, "skillNotFound", { name: route.skill }));
        return;
      }

      const result = await skill.execute({
        text: route.payload,
        ctx,
        workdir: ptyManager.getStatus(ctx.chat.id).workdir,
        locale
      });
      await sendSkillResult(ctx, result, locale);
    } catch (error) {
      await sendChunkedMarkdown(ctx, t(locale, "processingFailed", { error: error.message }));
    }
  });
}
