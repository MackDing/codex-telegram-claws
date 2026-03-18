import fs from "node:fs";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions as CodexThreadOptions
} from "@openai/codex-sdk";
import pty from "node-pty";
import throttle from "lodash.throttle";
import stripAnsi from "strip-ansi";
import type { AppConfig } from "../config.js";
import { formatPtyOutput, splitTelegramMessage } from "../bot/formatter.js";
import { normalizeLanguage, t, type Locale } from "../bot/i18n.js";
import { toErrorMessage } from "../lib/errors.js";
import { repairNodePtySpawnHelperPermissions } from "./ptyPreflight.js";
type SessionMode = "pty" | "exec" | "sdk";
type ExitSignal = number | NodeJS.Signals | null;
type WorkflowPhase =
  | "brainstorming"
  | "planning"
  | "implementing"
  | "verifying";

interface PtyProcess {
  write(input: string): void;
  kill(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal: number }) => void): void;
}

interface TelegramMessage {
  message_id: number;
}

interface TelegramApiLike {
  sendMessage(
    chatId: string | number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<TelegramMessage>;
  sendChatAction?(chatId: string | number, action: string): Promise<unknown>;
  sendDocument?(
    chatId: string | number,
    document: unknown,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  sendPhoto?(
    chatId: string | number,
    photo: unknown,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  sendVideo?(
    chatId: string | number,
    video: unknown,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  sendAudio?(
    chatId: string | number,
    audio: unknown,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  editMessageText(
    chatId: string | number,
    messageId: number,
    inlineMessageId: string | undefined,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  deleteMessage(chatId: string | number, messageId: number): Promise<unknown>;
}

interface BotLike {
  telegram: TelegramApiLike;
}

interface CodexThreadLike {
  id: string | null;
  runStreamed(
    input: string,
    options?: {
      signal?: AbortSignal;
    }
  ): Promise<{
    events: AsyncGenerator<ThreadEvent>;
  }>;
}

interface CodexClientLike {
  startThread(options?: CodexThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadLike;
}

interface ProjectConversationState {
  lastSessionId: string;
  lastMode: SessionMode | null;
  lastExitCode: number | null;
  lastExitSignal: ExitSignal;
  lastWorkflowPhase: WorkflowPhase | null;
}

interface ChatRuntimeState {
  preferredModel: string | null;
  language: Locale;
  verboseOutput: boolean;
  currentWorkdir: string;
  recentWorkdirs: string[];
  ptySupported: boolean | null;
  pendingPrompt: PendingPromptRequest | null;
  projectStates: Map<string, ProjectConversationState>;
}

interface RunnerSession {
  chatId: string;
  mode: SessionMode;
  workdir: string;
  model: string | null;
  sessionId: string;
  trackConversation: boolean;
  proc: PtyProcess | ChildProcessWithoutNullStreams | null;
  thread: CodexThreadLike | null;
  abortController: AbortController | null;
  renderableItems: Map<string, string>;
  renderableItemOrder: string[];
  rawBuffer: string;
  streamMessageIds: number[];
  lastRendered: string;
  flushQueue: Promise<void>;
  throttledFlush: ReturnType<typeof throttle>;
  chatActionInterval: NodeJS.Timeout | null;
  changedFiles: Set<string>;
  baselineChangedFiles: Set<string>;
  write: ((input: string) => void) | null;
  interrupt: (() => void) | null;
  close: (() => void) | null;
  workflowPhase: WorkflowPhase | null;
}

interface SessionOptions {
  workdir?: string;
  resumeSessionId?: string;
  initialPrompt?: string;
  fullAuto?: boolean;
  extraArgs?: string[];
  trackConversation?: boolean;
}

interface SendPromptOptions {
  forceExec?: boolean;
  fullAuto?: boolean;
  extraArgs?: string[];
  notice?: string;
  allowWorkspaceConflict?: boolean;
}

interface SendPromptContext {
  chat: {
    id: string | number;
  };
}

interface PendingPromptRequest {
  prompt: string;
  workdir: string;
  options: SendPromptOptions;
  blockingChatId: string;
}

interface SendPromptStartedResult {
  started: true;
  mode: SessionMode;
  fallback?: boolean;
  resumed?: boolean;
}

interface SendPromptBusyResult {
  started: false;
  reason: "busy";
  activeMode: SessionMode;
}

interface SendPromptWorkspaceBusyResult {
  started: false;
  reason: "workspace_busy";
  activeMode: SessionMode;
  blockingChatId: string;
  relativeWorkdir: string;
}

interface NoPendingPromptResult {
  started: false;
  reason: "no_pending_prompt";
}

export type SendPromptResult =
  | SendPromptStartedResult
  | SendPromptBusyResult
  | SendPromptWorkspaceBusyResult;

export type ContinuePendingPromptResult =
  | SendPromptStartedResult
  | SendPromptBusyResult
  | NoPendingPromptResult;

interface StoredProjectConversationState {
  lastSessionId?: unknown;
  lastMode?: unknown;
  lastExitCode?: unknown;
  lastExitSignal?: unknown;
  lastWorkflowPhase?: unknown;
}

interface StoredChatRuntimeState {
  preferredModel?: unknown;
  language?: unknown;
  verboseOutput?: unknown;
  currentWorkdir?: unknown;
  recentWorkdirs?: unknown;
  projects?: Record<string, StoredProjectConversationState>;
}

export interface PtyManagerSnapshot {
  chats: Record<
    string,
    {
      preferredModel: string | null;
      language: Locale;
      verboseOutput: boolean;
      currentWorkdir: string;
      recentWorkdirs: string[];
      projects: Record<
        string,
        {
          lastSessionId: string;
          lastMode: SessionMode | null;
          lastExitCode: number | null;
          lastExitSignal: ExitSignal;
          lastWorkflowPhase: WorkflowPhase | null;
        }
      >;
    }
  >;
}

export interface PtyManagerStatus {
  backend: AppConfig["runner"]["backend"];
  active: boolean;
  activeMode: SessionMode | null;
  lastMode: SessionMode | null;
  lastExitCode: number | null;
  lastExitSignal: ExitSignal;
  projectSessionId: string | null;
  preferredModel: string | null;
  language: Locale;
  verboseOutput: boolean;
  ptySupported: boolean | null;
  workdir: string;
  relativeWorkdir: string;
  workspaceRoot: string;
  command: string;
  mcpServers: string[];
  workflowSystem: "superpowers";
  workflowPhase: WorkflowPhase | "working" | "none";
}

interface PtyManagerOptions {
  bot: BotLike;
  config: Pick<AppConfig, "runner" | "workspace" | "reasoning" | "mcp">;
  onChange?: (snapshot: PtyManagerSnapshot) => void;
  codexClientFactory?: (options: CodexOptions) => CodexClientLike;
}

function isMessageNotModified(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { description?: unknown; message?: unknown };
  return String(candidate.description || candidate.message || "").includes(
    "message is not modified"
  );
}

function isPtySpawnFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { message?: unknown };
  return String(candidate.message || "").includes("posix_spawnp failed");
}

function extractSessionId(rawText: string): string {
  const matched = String(rawText || "").match(/session id:\s*([0-9a-f-]{36})/i);
  return matched?.[1] || "";
}

function isLocale(value: string): value is Locale {
  return value === "en" || value === "zh" || value === "zh-HK";
}

function toLocale(value: string): Locale {
  return isLocale(value) ? value : "en";
}

function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return (
    value === "brainstorming" ||
    value === "planning" ||
    value === "implementing" ||
    value === "verifying"
  );
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: unknown; message?: unknown };
  const name = String(candidate.name || "");
  const message = String(candidate.message || "");
  return name === "AbortError" || /aborted/i.test(message);
}

function summarizeSdkItem(item: ThreadItem, verbose: boolean): string | null {
  switch (item.type) {
    case "agent_message":
      return item.text?.trim() ? item.text : null;
    case "reasoning":
      return item.text?.trim() ? `<think>${item.text}</think>` : null;
    case "error":
      return item.message?.trim() ? `[error] ${item.message}` : null;
    case "command_execution":
      return verbose && item.command ? `[command] ${item.command}` : null;
    case "mcp_tool_call":
      return verbose
        ? `[mcp] ${item.server}/${item.tool} (${item.status})`
        : null;
    case "web_search":
      return verbose ? `[web] ${item.query}` : null;
    case "todo_list":
      return verbose && item.items.length
        ? item.items
            .map((entry) => `- [${entry.completed ? "x" : " "}] ${entry.text}`)
            .join("\n")
        : null;
    case "file_change":
      return verbose && item.changes.length
        ? `[files] ${item.changes.map((change) => `${change.kind}:${change.path}`).join(", ")}`
        : null;
    default:
      return null;
  }
}

const WORKFLOW_PHASE_MARKERS: ReadonlyArray<{
  phase: WorkflowPhase;
  markers: readonly string[];
}> = [
  {
    phase: "brainstorming",
    markers: [
      "using `brainstorming`",
      "brainstorming gate",
      "offer visual companion",
      "ask one clarifying question",
      "propose 2-3 approaches",
      "present design and get approval"
    ]
  },
  {
    phase: "planning",
    markers: [
      "implementation plan",
      "plan complete",
      "write the implementation plan",
      "writing the implementation plan",
      "moving into implementation planning",
      "implementation steps"
    ]
  },
  {
    phase: "implementing",
    markers: [
      "moving into file edits",
      "i'm implementing",
      "i’m implementing",
      "i'm adding",
      "i’m adding",
      "[files]",
      "apply_patch"
    ]
  },
  {
    phase: "verifying",
    markers: [
      "verification-before-completion",
      "running validation",
      "full verification",
      "fresh verification",
      "final verification",
      "all green",
      "all passed"
    ]
  }
];

const MAX_TELEGRAM_ARTIFACTS = 3;
const MAX_TELEGRAM_ARTIFACT_BYTES = 10 * 1024 * 1024;

function getArtifactTransport(filePath: string): {
  action: "upload_document" | "upload_photo" | "upload_video" | "upload_voice";
  method: "sendDocument" | "sendPhoto" | "sendVideo" | "sendAudio";
} {
  const extension = path.extname(filePath).toLowerCase();

  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    return {
      action: "upload_photo",
      method: "sendPhoto"
    };
  }

  if ([".mp4", ".mov", ".webm", ".mkv"].includes(extension)) {
    return {
      action: "upload_video",
      method: "sendVideo"
    };
  }

  if ([".mp3", ".wav", ".m4a", ".ogg"].includes(extension)) {
    return {
      action: "upload_voice",
      method: "sendAudio"
    };
  }

  return {
    action: "upload_document",
    method: "sendDocument"
  };
}

function normalizeGitStatusPath(rawPath: string, workdir: string): string {
  const normalized = String(rawPath || "").trim();
  if (!normalized) {
    return "";
  }

  const nextPath = normalized.includes(" -> ")
    ? normalized.split(" -> ").at(-1) || normalized
    : normalized;

  return path.resolve(workdir, nextPath);
}

function detectWorkflowPhase(rawText: string): WorkflowPhase | null {
  const normalized = String(rawText || "").toLowerCase();
  if (!normalized) {
    return null;
  }

  let bestMatch: { phase: WorkflowPhase; index: number } | null = null;

  for (const entry of WORKFLOW_PHASE_MARKERS) {
    for (const marker of entry.markers) {
      const index = normalized.lastIndexOf(marker);
      if (index === -1) {
        continue;
      }

      if (!bestMatch || index >= bestMatch.index) {
        bestMatch = {
          phase: entry.phase,
          index
        };
      }
    }
  }

  return bestMatch?.phase || null;
}

export class PtyManager {
  readonly bot: BotLike;
  readonly config: Pick<
    AppConfig,
    "runner" | "workspace" | "reasoning" | "mcp"
  >;
  readonly sessions: Map<string, RunnerSession>;
  readonly chatState: Map<string, ChatRuntimeState>;
  readonly ptyPreflight: {
    path: string;
    changed: boolean;
    executable: boolean;
    error?: string;
  };
  private readonly codexClientFactory: (
    options: CodexOptions
  ) => CodexClientLike;
  private codexClient: CodexClientLike | null;
  private readonly onChange?: (snapshot: PtyManagerSnapshot) => void;

  constructor({
    bot,
    config,
    onChange,
    codexClientFactory
  }: PtyManagerOptions) {
    this.bot = bot;
    this.config = config;
    this.onChange = onChange;
    this.codexClientFactory =
      codexClientFactory ??
      ((options: CodexOptions) =>
        new Codex(options) as unknown as CodexClientLike);
    this.codexClient = null;
    this.sessions = new Map();
    this.chatState = new Map();
    this.ptyPreflight = repairNodePtySpawnHelperPermissions();

    if (this.ptyPreflight.error) {
      console.warn(
        `[runner] node-pty preflight failed: ${this.ptyPreflight.error}`
      );
    } else if (this.ptyPreflight.changed) {
      console.info(
        `[runner] repaired node-pty helper permissions: ${this.ptyPreflight.path}`
      );
    }
  }

  ensureChatState(chatId: string | number): ChatRuntimeState {
    const key = String(chatId);
    const existing = this.chatState.get(key);
    if (existing) return existing;

    const state: ChatRuntimeState = {
      preferredModel: null,
      language: "en",
      verboseOutput: false,
      currentWorkdir: this.config.runner.cwd,
      recentWorkdirs: [this.config.runner.cwd],
      ptySupported: null,
      pendingPrompt: null,
      projectStates: new Map([
        [
          this.config.runner.cwd,
          {
            lastSessionId: "",
            lastMode: null,
            lastExitCode: null,
            lastExitSignal: null,
            lastWorkflowPhase: null
          }
        ]
      ])
    };

    this.chatState.set(key, state);
    return state;
  }

  ensureProjectState(
    chatId: string | number,
    workdir = this.getWorkdir(chatId)
  ): ProjectConversationState {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const resolvedWorkdir = path.resolve(
      workdir || state.currentWorkdir || this.config.runner.cwd
    );
    const existing = state.projectStates.get(resolvedWorkdir);
    if (existing) return existing;

    const projectState: ProjectConversationState = {
      lastSessionId: "",
      lastMode: null,
      lastExitCode: null,
      lastExitSignal: null,
      lastWorkflowPhase: null
    };

    state.projectStates.set(resolvedWorkdir, projectState);
    return projectState;
  }

  getCommandArgsForSession(chatId: string | number): string[] {
    const state = this.ensureChatState(chatId);
    const args = [...this.config.runner.args];
    if (state.preferredModel) {
      args.push("-m", state.preferredModel);
    }
    return args;
  }

  getCodexClient(): CodexClientLike {
    if (this.codexClient) {
      return this.codexClient;
    }

    const options: CodexOptions = {
      config: this.config.runner.sdkConfig
    };

    if (this.config.runner.command !== "codex") {
      options.codexPathOverride = this.config.runner.command;
    }

    this.codexClient = this.codexClientFactory(options);
    return this.codexClient;
  }

  getSdkThreadOptions(
    chatId: string | number,
    workdir: string,
    overrides: Partial<CodexThreadOptions> = {}
  ): CodexThreadOptions {
    const state = this.ensureChatState(chatId);
    const baseOptions = this.config.runner.sdkThreadOptions;
    const threadOptions: CodexThreadOptions = {
      workingDirectory: workdir,
      skipGitRepoCheck: baseOptions.skipGitRepoCheck,
      additionalDirectories: [...baseOptions.additionalDirectories]
    };

    if (baseOptions.sandboxMode) {
      threadOptions.sandboxMode = baseOptions.sandboxMode;
    }
    if (baseOptions.approvalPolicy) {
      threadOptions.approvalPolicy = baseOptions.approvalPolicy;
    }
    if (baseOptions.modelReasoningEffort) {
      threadOptions.modelReasoningEffort = baseOptions.modelReasoningEffort;
    }
    if (typeof baseOptions.networkAccessEnabled === "boolean") {
      threadOptions.networkAccessEnabled = baseOptions.networkAccessEnabled;
    }
    if (baseOptions.webSearchMode) {
      threadOptions.webSearchMode = baseOptions.webSearchMode;
    }
    if (state.preferredModel) {
      threadOptions.model = state.preferredModel;
    }

    const merged = {
      ...threadOptions,
      ...overrides,
      workingDirectory: workdir
    };

    if (merged.approvalPolicy === undefined) {
      delete merged.approvalPolicy;
    }
    if (merged.sandboxMode === undefined) {
      delete merged.sandboxMode;
    }
    if (merged.modelReasoningEffort === undefined) {
      delete merged.modelReasoningEffort;
    }
    if (merged.networkAccessEnabled === undefined) {
      delete merged.networkAccessEnabled;
    }
    if (merged.webSearchMode === undefined) {
      delete merged.webSearchMode;
    }
    if (!merged.model) {
      delete merged.model;
    }
    if (!merged.additionalDirectories?.length) {
      delete merged.additionalDirectories;
    }

    return merged;
  }

  rememberSessionId(session: RunnerSession, sessionId: string): void {
    if (!sessionId || sessionId === session.sessionId) return;

    session.sessionId = sessionId;
    if (!session.trackConversation) return;

    const projectState = this.ensureProjectState(
      session.chatId,
      session.workdir
    );
    projectState.lastSessionId = sessionId;
    this.onChange?.(this.exportState());
  }

  isVerbose(chatId: string | number): boolean {
    const state = this.ensureChatState(chatId);
    return Boolean(state.verboseOutput);
  }

  getLanguage(chatId: string | number): Locale {
    const state = this.ensureChatState(chatId);
    return toLocale(normalizeLanguage(state.language) || "en");
  }

  setLanguage(chatId: string | number, language: string): Locale {
    const normalized = normalizeLanguage(language);
    if (!normalized) {
      throw new Error("Unsupported language.");
    }

    const state = this.ensureChatState(chatId);
    state.language = toLocale(normalized);
    this.onChange?.(this.exportState());
    return state.language;
  }

  setVerbose(chatId: string | number, enabled: boolean): boolean {
    const state = this.ensureChatState(chatId);
    state.verboseOutput = Boolean(enabled);
    this.onChange?.(this.exportState());
    return state.verboseOutput;
  }

  getWorkdir(chatId: string | number): string {
    const state = this.ensureChatState(chatId);
    return state.currentWorkdir || this.config.runner.cwd;
  }

  getRelativeWorkdir(chatId: string | number): string {
    const workdir = this.getWorkdir(chatId);
    const relative = path.relative(this.config.workspace.root, workdir);
    return relative || ".";
  }

  getProjectState(
    chatId: string | number,
    workdir = this.getWorkdir(chatId)
  ): ProjectConversationState {
    return this.ensureProjectState(chatId, workdir);
  }

  rememberWorkdir(state: ChatRuntimeState, workdir: string): void {
    const history = [
      workdir,
      ...(state.recentWorkdirs || []).filter((item) => item !== workdir)
    ];
    state.recentWorkdirs = history.slice(0, 6);
  }

  clearPendingPrompt(chatId: string | number): void {
    const state = this.ensureChatState(chatId);
    state.pendingPrompt = null;
  }

  storePendingPrompt(
    chatId: string | number,
    prompt: string,
    workdir: string,
    options: SendPromptOptions,
    blockingChatId: string
  ): void {
    const state = this.ensureChatState(chatId);
    const replayOptions: SendPromptOptions = {};

    if (options.forceExec) {
      replayOptions.forceExec = true;
    }
    if (options.fullAuto) {
      replayOptions.fullAuto = true;
    }
    if (options.extraArgs?.length) {
      replayOptions.extraArgs = [...options.extraArgs];
    }
    if (options.notice) {
      replayOptions.notice = options.notice;
    }

    state.pendingPrompt = {
      prompt,
      workdir,
      options: replayOptions,
      blockingChatId
    };
  }

  findWorkspaceConflict(
    chatId: string | number,
    workdir: string
  ): RunnerSession | null {
    const key = String(chatId);
    const resolvedWorkdir = path.resolve(workdir);

    for (const session of this.sessions.values()) {
      if (session.chatId === key) {
        continue;
      }

      if (path.resolve(session.workdir) === resolvedWorkdir) {
        return session;
      }
    }

    return null;
  }

  isInsideWorkspaceRoot(candidate: string): boolean {
    const root = path.resolve(this.config.workspace.root);
    const target = path.resolve(candidate);
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  listProjects(): Array<{ name: string; path: string; relativePath: string }> {
    const root = this.config.workspace.root;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const projects: Array<{
      name: string;
      path: string;
      relativePath: string;
    }> = [];

    if (fs.existsSync(path.join(root, ".git"))) {
      projects.push({
        name: path.basename(root),
        path: root,
        relativePath: "."
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(root, entry.name);
      if (!fs.existsSync(path.join(fullPath, ".git"))) continue;

      projects.push({
        name: entry.name,
        path: fullPath,
        relativePath: entry.name
      });
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  getRecentProjects(
    chatId: string | number
  ): Array<{ path: string; relativePath: string }> {
    const state = this.ensureChatState(chatId);
    return (state.recentWorkdirs || [])
      .filter(
        (workdir) =>
          fs.existsSync(workdir) && this.isInsideWorkspaceRoot(workdir)
      )
      .map((workdir) => ({
        path: workdir,
        relativePath: path.relative(this.config.workspace.root, workdir) || "."
      }));
  }

  switchWorkdir(
    chatId: string | number,
    targetName: string
  ): { workdir: string; relativePath: string } {
    const key = String(chatId);
    const requested = String(targetName || "").trim();
    if (!requested) {
      throw new Error(t(this.getLanguage(key), "projectNameRequired"));
    }

    const root = this.config.workspace.root;
    let targetPath: string;

    if (requested === "." || requested === path.basename(root)) {
      targetPath = root;
    } else {
      targetPath = path.resolve(root, requested);
    }

    if (!this.isInsideWorkspaceRoot(targetPath)) {
      throw new Error(t(this.getLanguage(key), "targetOutsideWorkspaceRoot"));
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new Error(
        t(this.getLanguage(key), "projectDirDoesNotExist", { path: targetPath })
      );
    }

    if (!fs.existsSync(path.join(targetPath, ".git"))) {
      throw new Error(
        t(this.getLanguage(key), "targetNotGitRepository", { path: targetPath })
      );
    }

    const state = this.ensureChatState(key);
    this.ensureProjectState(key, targetPath);
    state.currentWorkdir = targetPath;
    this.rememberWorkdir(state, targetPath);
    state.pendingPrompt = null;
    this.closeSession(key);
    this.onChange?.(this.exportState());

    return {
      workdir: targetPath,
      relativePath: path.relative(root, targetPath) || "."
    };
  }

  switchToPreviousWorkdir(chatId: string | number): {
    workdir: string;
    relativePath: string;
  } {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const previous = (state.recentWorkdirs || []).find(
      (workdir) => workdir !== state.currentWorkdir
    );

    if (!previous) {
      throw new Error(t(this.getLanguage(key), "noPreviousProject"));
    }

    return this.switchWorkdir(key, previous);
  }

  getExecArgs(
    chatId: string | number,
    prompt: string,
    options: SessionOptions = {}
  ): string[] {
    const state = this.ensureChatState(chatId);
    const args = options.resumeSessionId ? ["exec", "resume"] : ["exec"];

    if (options.fullAuto) {
      args.push("--full-auto");
    }

    if (state.preferredModel) {
      args.push("-m", state.preferredModel);
    }

    if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
      args.push(...options.extraArgs);
    }

    if (options.resumeSessionId) {
      args.push(options.resumeSessionId);
    }

    args.push(prompt);
    return args;
  }

  getInteractiveArgs(
    chatId: string | number,
    options: SessionOptions = {}
  ): string[] {
    const args = options.resumeSessionId
      ? ["resume", options.resumeSessionId]
      : this.getCommandArgsForSession(chatId);

    if (options.resumeSessionId && options.initialPrompt) {
      args.push(options.initialPrompt);
    }

    return args;
  }

  createBaseSession(
    chatId: string | number,
    mode: SessionMode,
    options: SessionOptions = {}
  ): RunnerSession {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const workdir = path.resolve(
      options.workdir || state.currentWorkdir || this.config.runner.cwd
    );
    const projectState = this.ensureProjectState(key, workdir);
    const baselineChangedFiles = this.listChangedFilesFromGit(workdir);
    const session: RunnerSession = {
      chatId: key,
      mode,
      workdir,
      model: state.preferredModel,
      sessionId: projectState.lastSessionId || "",
      trackConversation: options.trackConversation !== false,
      proc: null,
      thread: null,
      abortController: null,
      renderableItems: new Map(),
      renderableItemOrder: [],
      rawBuffer: "",
      streamMessageIds: [],
      lastRendered: "",
      flushQueue: Promise.resolve(),
      throttledFlush: throttle(
        () => this.enqueueFlush(key),
        this.config.runner.throttleMs,
        { leading: true, trailing: true }
      ),
      chatActionInterval: null,
      changedFiles: new Set(),
      baselineChangedFiles,
      write: null,
      interrupt: null,
      close: null,
      workflowPhase: null
    };

    this.sessions.set(key, session);
    this.startChatActionHeartbeat(session);
    return session;
  }

  startChatActionHeartbeat(session: RunnerSession): void {
    const sendChatAction = this.bot.telegram.sendChatAction;
    if (!sendChatAction) {
      return;
    }

    const send = () =>
      sendChatAction
        .call(this.bot.telegram, session.chatId, "typing")
        .catch(() => {});

    send();
    session.chatActionInterval = setInterval(send, 4000);
  }

  stopChatActionHeartbeat(session: RunnerSession): void {
    if (!session.chatActionInterval) {
      return;
    }

    clearInterval(session.chatActionInterval);
    session.chatActionInterval = null;
  }

  listChangedFilesFromGit(workdir: string): Set<string> {
    try {
      const output = execFileSync(
        "git",
        ["status", "--short", "--untracked-files=all"],
        {
          cwd: workdir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }
      );

      return new Set(
        output
          .split("\n")
          .map((line) => line.slice(3))
          .map((entry) => normalizeGitStatusPath(entry, workdir))
          .filter(Boolean)
      );
    } catch {
      return new Set();
    }
  }

  captureSessionMetadata(session: RunnerSession): void {
    if (!session.trackConversation) return;

    const sessionId = extractSessionId(session.rawBuffer);
    this.rememberSessionId(session, sessionId);
  }

  captureWorkflowPhase(session: RunnerSession): void {
    const workflowPhase = detectWorkflowPhase(session.rawBuffer);
    if (workflowPhase) {
      session.workflowPhase = workflowPhase;
    }
  }

  updateSdkRenderableItem(session: RunnerSession, item: ThreadItem): void {
    const text = summarizeSdkItem(item, this.isVerbose(session.chatId));
    this.captureChangedFiles(session, item);
    const hasEntry = session.renderableItems.has(item.id);

    if (!text) {
      if (hasEntry) {
        session.renderableItems.delete(item.id);
        session.renderableItemOrder = session.renderableItemOrder.filter(
          (entryId) => entryId !== item.id
        );
      }
      session.rawBuffer = this.composeSdkRawBuffer(session);
      this.captureWorkflowPhase(session);
      return;
    }

    if (!hasEntry) {
      session.renderableItemOrder.push(item.id);
    }

    session.renderableItems.set(item.id, text);
    session.rawBuffer = this.composeSdkRawBuffer(session);
    this.captureWorkflowPhase(session);
  }

  composeSdkRawBuffer(session: RunnerSession): string {
    return session.renderableItemOrder
      .map((itemId) => session.renderableItems.get(itemId) || "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  captureChangedFiles(session: RunnerSession, item: ThreadItem): void {
    if (item.type !== "file_change") {
      return;
    }

    for (const change of item.changes || []) {
      if (!change?.path) {
        continue;
      }

      session.changedFiles.add(path.resolve(session.workdir, change.path));
    }
  }

  async sendChangedFilesToTelegram(session: RunnerSession): Promise<void> {
    if (!session.changedFiles.size) {
      return;
    }

    const eligibleFiles = [...session.changedFiles]
      .filter((filePath) => {
        if (!fs.existsSync(filePath)) {
          console.info(
            `[artifacts] skipping missing file for chat ${session.chatId}: ${filePath}`
          );
          return false;
        }

        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            console.info(
              `[artifacts] skipping non-file path for chat ${session.chatId}: ${filePath}`
            );
            return false;
          }
          if (stat.size > MAX_TELEGRAM_ARTIFACT_BYTES) {
            console.info(
              `[artifacts] skipping oversized file for chat ${session.chatId}: ${filePath} (${stat.size} bytes)`
            );
            return false;
          }

          return true;
        } catch {
          return false;
        }
      })
      .sort();
    const candidates = eligibleFiles.slice(0, MAX_TELEGRAM_ARTIFACTS);

    if (!candidates.length) {
      console.info(
        `[artifacts] no eligible files to send for chat ${session.chatId}`
      );
    }

    if (candidates.length > 1) {
      const fileLines = candidates.map((filePath) => {
        const relativePath =
          path.relative(session.workdir, filePath) || path.basename(filePath);
        return `- ${relativePath}`;
      });
      const omittedCount = Math.max(
        0,
        eligibleFiles.length - candidates.length
      );

      await this.bot.telegram
        .sendMessage(
          session.chatId,
          t(this.getLanguage(session.chatId), "artifactBatchNotice", {
            sentCount: candidates.length,
            totalCount: eligibleFiles.length,
            fileLines,
            omittedCount
          })
        )
        .catch(() => {});
    }

    for (const filePath of candidates) {
      const relativePath =
        path.relative(session.workdir, filePath) || path.basename(filePath);
      const transport = getArtifactTransport(filePath);
      const sender = this.bot.telegram[transport.method];

      if (!sender) {
        console.warn(
          `[artifacts] telegram method ${transport.method} is unavailable for ${relativePath}`
        );
        continue;
      }

      await this.bot.telegram
        .sendChatAction?.(session.chatId, transport.action)
        .catch(() => {});

      await sender
        .call(
          this.bot.telegram,
          session.chatId,
          {
            source: filePath,
            filename: path.basename(filePath)
          },
          {
            caption: `Generated file: ${relativePath}`
          }
        )
        .then(() => {
          console.info(
            `[artifacts] sent ${relativePath} to chat ${session.chatId} via ${transport.method}`
          );
        })
        .catch((error: unknown) => {
          console.warn(
            `[artifacts] failed to send ${relativePath} to chat ${session.chatId}: ${toErrorMessage(error)}`
          );
        });
    }
  }

  async finalizeSession(
    session: RunnerSession,
    exitCode: number | null,
    signal: ExitSignal
  ): Promise<void> {
    this.stopChatActionHeartbeat(session);
    const changedNow = this.listChangedFilesFromGit(session.workdir);
    for (const filePath of changedNow) {
      if (!session.baselineChangedFiles.has(filePath)) {
        session.changedFiles.add(filePath);
      }
    }
    await session.flushQueue.catch(() => {});
    await this.flushToTelegram(session.chatId).catch(() => {});
    await this.sendChangedFilesToTelegram(session);
    this.captureSessionMetadata(session);
    const projectState = this.ensureProjectState(
      session.chatId,
      session.workdir
    );
    projectState.lastMode = session.mode;
    projectState.lastExitCode = exitCode;
    projectState.lastExitSignal = signal;
    projectState.lastWorkflowPhase = session.workflowPhase;
    this.onChange?.(this.exportState());

    if (this.sessions.get(session.chatId) === session) {
      this.enqueueFlush(session.chatId);
    }

    if (this.isVerbose(session.chatId)) {
      await this.bot.telegram
        .sendMessage(
          session.chatId,
          t(this.getLanguage(session.chatId), "codexSessionExited", {
            mode: session.mode,
            exitCode,
            signal
          })
        )
        .catch(() => {});
    }

    session.throttledFlush.cancel();
    if (this.sessions.get(session.chatId) === session) {
      this.sessions.delete(session.chatId);
    }
  }

  attachOutput(
    session: RunnerSession,
    stream:
      | NodeJS.ReadableStream
      | { on: (event: "data", listener: (chunk: unknown) => void) => void }
  ): void {
    stream.on("data", (chunk: unknown) => {
      session.rawBuffer += stripAnsi(String(chunk || "")).replace(/\r/g, "");
      if (session.rawBuffer.length > this.config.runner.maxBufferChars) {
        session.rawBuffer = session.rawBuffer.slice(
          -this.config.runner.maxBufferChars
        );
      }
      this.captureSessionMetadata(session);
      this.captureWorkflowPhase(session);
      session.throttledFlush();
    });
  }

  attachExit(
    session: RunnerSession,
    handler: (
      listener: (payload: {
        exitCode: number | null;
        signal: ExitSignal;
      }) => void
    ) => void
  ): void {
    handler(async ({ exitCode, signal }) => {
      await this.finalizeSession(session, exitCode, signal);
    });
  }

  startPtySession(
    chatId: string | number,
    options: SessionOptions = {}
  ): RunnerSession {
    const session = this.createBaseSession(chatId, "pty", options);
    const proc = pty.spawn(
      this.config.runner.command,
      this.getInteractiveArgs(chatId, options),
      {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: session.workdir,
        env: {
          ...process.env,
          FORCE_COLOR: "1"
        }
      }
    ) as PtyProcess;

    this.ensureChatState(chatId).ptySupported = true;
    session.proc = proc;
    session.write = (input: string) => proc.write(input);
    session.interrupt = () => proc.write("\u0003");
    session.close = () => proc.kill();

    proc.onData((chunk) => {
      session.rawBuffer += stripAnsi(String(chunk || "")).replace(/\r/g, "");
      if (session.rawBuffer.length > this.config.runner.maxBufferChars) {
        session.rawBuffer = session.rawBuffer.slice(
          -this.config.runner.maxBufferChars
        );
      }
      this.captureSessionMetadata(session);
      this.captureWorkflowPhase(session);
      session.throttledFlush();
    });

    this.attachExit(session, (listener) => proc.onExit(listener));
    return session;
  }

  startExecSessionWithOptions(
    chatId: string | number,
    prompt: string,
    options: SessionOptions = {}
  ): RunnerSession {
    const session = this.createBaseSession(chatId, "exec", options);
    const proc = spawn(
      this.config.runner.command,
      this.getExecArgs(chatId, prompt, options),
      {
        cwd: session.workdir,
        env: process.env
      }
    );

    session.proc = proc;
    session.write = null;
    session.interrupt = () => proc.kill("SIGINT");
    session.close = () => proc.kill("SIGTERM");

    if (proc.stdout) {
      this.attachOutput(session, proc.stdout);
    }
    if (proc.stderr) {
      this.attachOutput(session, proc.stderr);
    }
    this.attachExit(session, (listener) =>
      proc.on("close", (exitCode, signal) => listener({ exitCode, signal }))
    );

    proc.on("error", async (error) => {
      this.stopChatActionHeartbeat(session);
      await this.bot.telegram
        .sendMessage(
          session.chatId,
          t(this.getLanguage(session.chatId), "codexExecFailed", {
            error: error.message
          })
        )
        .catch(() => {});
      session.throttledFlush.cancel();
      this.sessions.delete(session.chatId);
    });

    return session;
  }

  startSdkSessionWithOptions(
    chatId: string | number,
    prompt: string,
    options: SessionOptions = {}
  ): RunnerSession {
    const session = this.createBaseSession(chatId, "sdk", options);
    const controller = new AbortController();

    session.abortController = controller;
    session.interrupt = () => controller.abort();
    session.close = () => controller.abort();

    void this.runSdkTurn(session, prompt, options);
    return session;
  }

  async runSdkTurn(
    session: RunnerSession,
    prompt: string,
    options: SessionOptions = {}
  ): Promise<void> {
    let exitCode: number | null = 0;
    let signal: ExitSignal = null;

    try {
      const threadOptions = this.getSdkThreadOptions(
        session.chatId,
        session.workdir,
        {
          approvalPolicy: options.fullAuto ? "never" : undefined
        }
      );
      const codex = this.getCodexClient();
      const thread = options.resumeSessionId
        ? codex.resumeThread(options.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);

      session.thread = thread;
      if (thread.id) {
        this.rememberSessionId(session, thread.id);
      }

      const streamed = await thread.runStreamed(prompt, {
        signal: session.abortController?.signal
      });

      for await (const event of streamed.events) {
        if (event.type === "thread.started") {
          this.rememberSessionId(session, event.thread_id);
          continue;
        }

        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          this.updateSdkRenderableItem(session, event.item);
          session.throttledFlush();
          continue;
        }

        if (event.type === "turn.failed") {
          exitCode = 1;
          session.rawBuffer = [session.rawBuffer, event.error.message]
            .filter(Boolean)
            .join("\n\n");
          session.throttledFlush();
          continue;
        }

        if (event.type === "error") {
          exitCode = 1;
          session.rawBuffer = [session.rawBuffer, event.message]
            .filter(Boolean)
            .join("\n\n");
          session.throttledFlush();
        }
      }
    } catch (error) {
      if (isAbortError(error) || session.abortController?.signal.aborted) {
        exitCode = null;
        signal = "SIGINT";
      } else {
        exitCode = 1;
        await this.bot.telegram
          .sendMessage(
            session.chatId,
            t(this.getLanguage(session.chatId), "codexExecFailed", {
              error: toErrorMessage(error)
            })
          )
          .catch(() => {});
      }
    } finally {
      await this.finalizeSession(session, exitCode, signal);
    }
  }

  ensureSession(
    chatId: string | number,
    options: SessionOptions = {}
  ): RunnerSession | null {
    if (this.config.runner.backend !== "cli") {
      return null;
    }

    const key = String(chatId);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    try {
      return this.startPtySession(key, options);
    } catch (error) {
      if (!isPtySpawnFailure(error)) {
        throw error;
      }

      this.ensureChatState(key).ptySupported = false;
      console.warn(
        `[runner] PTY spawn failed for chat ${key}; falling back to codex exec mode.`
      );
      return null;
    }
  }

  enqueueFlush(chatId: string | number): void {
    const key = String(chatId);
    const session = this.sessions.get(key);
    if (!session) return;

    session.flushQueue = session.flushQueue
      .then(() => this.flushToTelegram(key))
      .catch(() => {});
  }

  async flushToTelegram(chatId: string | number): Promise<void> {
    const session = this.sessions.get(String(chatId));
    if (!session) return;

    const rawTail = session.rawBuffer.slice(-60000);
    const rendered = formatPtyOutput(rawTail, {
      mode: this.config.reasoning.mode,
      sessionMode: session.mode
    });
    if (rendered === session.lastRendered) return;
    session.lastRendered = rendered;

    const chunks = splitTelegramMessage(
      rendered,
      this.config.runner.telegramChunkSize
    );
    const existing = session.streamMessageIds;
    const nextIds: number[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const existingMessageId = existing[i];

      if (existingMessageId) {
        try {
          await this.bot.telegram.editMessageText(
            chatId,
            existingMessageId,
            undefined,
            chunk,
            {
              parse_mode: "MarkdownV2",
              disable_web_page_preview: true
            }
          );
          nextIds.push(existingMessageId);
        } catch (error) {
          if (!isMessageNotModified(error)) {
            const sent = await this.bot.telegram.sendMessage(chatId, chunk, {
              parse_mode: "MarkdownV2",
              disable_web_page_preview: true
            });
            nextIds.push(sent.message_id);
          } else {
            nextIds.push(existingMessageId);
          }
        }
      } else {
        const sent = await this.bot.telegram.sendMessage(chatId, chunk, {
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true
        });
        nextIds.push(sent.message_id);
      }
    }

    for (let i = chunks.length; i < existing.length; i += 1) {
      const staleId = existing[i];
      await this.bot.telegram.deleteMessage(chatId, staleId).catch(() => {});
    }

    session.streamMessageIds = nextIds;
  }

  async sendPrompt(
    ctx: SendPromptContext,
    prompt: string,
    options: SendPromptOptions = {}
  ): Promise<SendPromptResult> {
    const chatId = String(ctx.chat.id);
    const workdir = this.getWorkdir(chatId);
    const projectState = this.ensureProjectState(chatId);
    const state = this.ensureChatState(chatId);

    if (!options.allowWorkspaceConflict) {
      const conflict = this.findWorkspaceConflict(chatId, workdir);
      if (conflict) {
        this.storePendingPrompt(
          chatId,
          prompt,
          workdir,
          options,
          conflict.chatId
        );
        return {
          started: false,
          reason: "workspace_busy",
          activeMode: conflict.mode,
          blockingChatId: conflict.chatId,
          relativeWorkdir: this.serializeWorkdir(workdir)
        };
      }
    }

    state.pendingPrompt = null;

    if (this.config.runner.backend === "sdk") {
      const running = this.sessions.get(chatId);
      if (running) {
        return {
          started: false,
          reason: "busy",
          activeMode: running.mode
        };
      }

      const resumed = Boolean(projectState.lastSessionId && !options.forceExec);
      const session = this.startSdkSessionWithOptions(chatId, prompt, {
        fullAuto: Boolean(options.fullAuto),
        extraArgs: options.extraArgs || [],
        workdir,
        resumeSessionId:
          options.forceExec || !projectState.lastSessionId
            ? ""
            : projectState.lastSessionId,
        trackConversation: !options.forceExec
      });

      if (options.notice && this.isVerbose(chatId)) {
        await this.bot.telegram
          .sendMessage(chatId, options.notice)
          .catch(() => {});
      }

      if (!session.streamMessageIds.length && this.isVerbose(chatId)) {
        const sent = await this.bot.telegram.sendMessage(
          chatId,
          resumed
            ? t(this.getLanguage(chatId), "sessionRestored", {
                project: this.getRelativeWorkdir(chatId),
                mode: session.mode
              })
            : t(this.getLanguage(chatId), "sessionStarted", {
                mode: session.mode
              })
        );
        session.streamMessageIds.push(sent.message_id);
      }

      return {
        started: true,
        mode: "sdk",
        resumed
      };
    }

    if (options.forceExec) {
      const running = this.sessions.get(chatId);
      if (running) {
        return {
          started: false,
          reason: "busy",
          activeMode: running.mode
        };
      }

      this.startExecSessionWithOptions(chatId, prompt, {
        fullAuto: Boolean(options.fullAuto),
        extraArgs: options.extraArgs || [],
        workdir,
        trackConversation: false
      });

      if (options.notice && this.isVerbose(chatId)) {
        await this.bot.telegram.sendMessage(chatId, options.notice);
      }

      return {
        started: true,
        mode: "exec"
      };
    }

    const existingSession = this.sessions.get(chatId);
    if (existingSession) {
      if (existingSession.mode === "exec") {
        return {
          started: false,
          reason: "busy",
          activeMode: existingSession.mode
        };
      }

      existingSession.write?.(`${prompt}\r`);
      return {
        started: true,
        mode: "pty"
      };
    }

    let session = this.ensureSession(
      chatId,
      projectState.lastSessionId
        ? {
            workdir,
            resumeSessionId: projectState.lastSessionId,
            initialPrompt: prompt
          }
        : {
            workdir
          }
    );

    if (!session) {
      session = this.startExecSessionWithOptions(chatId, prompt, {
        fullAuto: Boolean(options.fullAuto),
        extraArgs: options.extraArgs || [],
        workdir,
        resumeSessionId: projectState.lastSessionId || ""
      });
      if (this.isVerbose(chatId)) {
        await this.bot.telegram.sendMessage(
          chatId,
          projectState.lastSessionId
            ? t(this.getLanguage(chatId), "execFallbackResume")
            : t(this.getLanguage(chatId), "execFallbackSingle")
        );
      }
      return {
        started: true,
        mode: "exec",
        fallback: true,
        resumed: Boolean(projectState.lastSessionId)
      };
    }

    if (!session.streamMessageIds.length && this.isVerbose(chatId)) {
      const sent = await this.bot.telegram.sendMessage(
        chatId,
        projectState.lastSessionId
          ? t(this.getLanguage(chatId), "sessionRestored", {
              project: this.getRelativeWorkdir(chatId),
              mode: session.mode
            })
          : t(this.getLanguage(chatId), "sessionStarted", {
              mode: session.mode
            })
      );
      session.streamMessageIds.push(sent.message_id);
    }

    if (projectState.lastSessionId) {
      return {
        started: true,
        mode: "pty",
        resumed: true
      };
    }

    session.write?.(`${prompt}\r`);
    return {
      started: true,
      mode: "pty"
    };
  }

  async continuePendingPrompt(
    ctx: SendPromptContext
  ): Promise<ContinuePendingPromptResult> {
    const chatId = String(ctx.chat.id);
    const state = this.ensureChatState(chatId);
    const pending = state.pendingPrompt;

    if (!pending) {
      return {
        started: false,
        reason: "no_pending_prompt"
      };
    }

    state.pendingPrompt = null;

    try {
      const result = await this.sendPrompt(ctx, pending.prompt, {
        ...pending.options,
        allowWorkspaceConflict: true
      });

      if (!result.started) {
        state.pendingPrompt = pending;
        return {
          started: false,
          reason: "busy",
          activeMode: result.activeMode
        };
      }

      return result;
    } catch (error) {
      state.pendingPrompt = pending;
      throw error;
    }
  }

  interrupt(chatId: string | number): boolean {
    const session = this.sessions.get(String(chatId));
    if (!session) return false;
    session.interrupt?.();
    return true;
  }

  resetCurrentProjectConversation(chatId: string | number): {
    closed: boolean;
    workdir: string;
  } {
    const key = String(chatId);
    const workdir = this.getWorkdir(key);
    const projectState = this.ensureProjectState(key, workdir);
    const closed = this.closeSession(key);

    projectState.lastSessionId = "";
    projectState.lastMode = null;
    projectState.lastExitCode = null;
    projectState.lastExitSignal = null;
    projectState.lastWorkflowPhase = null;
    this.onChange?.(this.exportState());

    return {
      closed,
      workdir
    };
  }

  closeSession(chatId: string | number): boolean {
    const key = String(chatId);
    const session = this.sessions.get(key);
    if (!session) return false;

    session.throttledFlush.cancel();
    session.close?.();
    this.sessions.delete(key);
    return true;
  }

  async shutdown(): Promise<void> {
    for (const chatId of this.sessions.keys()) {
      this.closeSession(chatId);
    }
  }

  serializeWorkdir(workdir: string): string {
    const relative = path.relative(this.config.workspace.root, workdir);
    if (!relative) return ".";
    return !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : workdir;
  }

  resolveStoredWorkdir(stored: unknown): string | null {
    if (!stored || typeof stored !== "string") return null;
    const candidate = path.isAbsolute(stored)
      ? path.resolve(stored)
      : path.resolve(this.config.workspace.root, stored);

    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      return null;
    }

    if (!this.isInsideWorkspaceRoot(candidate)) {
      return null;
    }

    return candidate;
  }

  exportState(): PtyManagerSnapshot {
    const chats: PtyManagerSnapshot["chats"] = {};

    for (const [chatId, state] of this.chatState.entries()) {
      const projects: PtyManagerSnapshot["chats"][string]["projects"] = {};
      for (const [workdir, projectState] of state.projectStates.entries()) {
        projects[this.serializeWorkdir(workdir)] = {
          lastSessionId: projectState.lastSessionId || "",
          lastMode: projectState.lastMode,
          lastExitCode: projectState.lastExitCode,
          lastExitSignal: projectState.lastExitSignal,
          lastWorkflowPhase: projectState.lastWorkflowPhase
        };
      }

      chats[chatId] = {
        preferredModel: state.preferredModel,
        language: this.getLanguage(chatId),
        verboseOutput: Boolean(state.verboseOutput),
        currentWorkdir: this.serializeWorkdir(state.currentWorkdir),
        recentWorkdirs: (state.recentWorkdirs || []).map((workdir) =>
          this.serializeWorkdir(workdir)
        ),
        projects
      };
    }

    return {
      chats
    };
  }

  restoreState(snapshot: Partial<PtyManagerSnapshot> = {}): void {
    const chats = snapshot?.chats;
    if (!chats || typeof chats !== "object") return;

    this.chatState.clear();

    for (const [chatId, rawState] of Object.entries(
      chats as Record<string, StoredChatRuntimeState>
    )) {
      const currentWorkdir =
        this.resolveStoredWorkdir(rawState?.currentWorkdir) ||
        this.config.runner.cwd;

      const recentWorkdirs = Array.isArray(rawState?.recentWorkdirs)
        ? rawState.recentWorkdirs
            .map((stored) => this.resolveStoredWorkdir(stored))
            .filter((workdir): workdir is string => Boolean(workdir))
        : [];

      const projectStates = new Map<string, ProjectConversationState>();
      const rawProjects = rawState?.projects;
      if (rawProjects && typeof rawProjects === "object") {
        for (const [storedWorkdir, rawProjectState] of Object.entries(
          rawProjects
        )) {
          const resolvedWorkdir = this.resolveStoredWorkdir(storedWorkdir);
          if (!resolvedWorkdir) continue;

          projectStates.set(resolvedWorkdir, {
            lastSessionId: String(rawProjectState?.lastSessionId || "").trim(),
            lastMode:
              rawProjectState?.lastMode === "pty" ||
              rawProjectState?.lastMode === "exec" ||
              rawProjectState?.lastMode === "sdk"
                ? rawProjectState.lastMode
                : null,
            lastExitCode:
              rawProjectState?.lastExitCode === null ||
              rawProjectState?.lastExitCode === undefined
                ? null
                : Number(rawProjectState.lastExitCode),
            lastExitSignal:
              rawProjectState?.lastExitSignal === null ||
              rawProjectState?.lastExitSignal === undefined
                ? null
                : (rawProjectState.lastExitSignal as ExitSignal),
            lastWorkflowPhase: isWorkflowPhase(
              rawProjectState?.lastWorkflowPhase
            )
              ? rawProjectState.lastWorkflowPhase
              : null
          });
        }
      }

      if (!projectStates.has(currentWorkdir)) {
        projectStates.set(currentWorkdir, {
          lastSessionId: "",
          lastMode: null,
          lastExitCode: null,
          lastExitSignal: null,
          lastWorkflowPhase: null
        });
      }

      this.chatState.set(String(chatId), {
        preferredModel:
          typeof rawState?.preferredModel === "string" &&
          rawState.preferredModel.trim()
            ? rawState.preferredModel.trim()
            : null,
        language: toLocale(
          normalizeLanguage(String(rawState?.language || "")) || "en"
        ),
        verboseOutput: Boolean(rawState?.verboseOutput),
        currentWorkdir,
        recentWorkdirs: [
          currentWorkdir,
          ...recentWorkdirs.filter((workdir) => workdir !== currentWorkdir)
        ].slice(0, 6),
        ptySupported: null,
        pendingPrompt: null,
        projectStates
      });
    }
  }

  getStatus(chatId: string | number): PtyManagerStatus {
    const key = String(chatId);
    const state = this.ensureChatState(key);
    const projectState = this.ensureProjectState(key, state.currentWorkdir);
    const session = this.sessions.get(key);

    return {
      backend: this.config.runner.backend,
      active: Boolean(session),
      activeMode: session?.mode || null,
      lastMode: projectState.lastMode,
      lastExitCode: projectState.lastExitCode,
      lastExitSignal: projectState.lastExitSignal,
      projectSessionId: projectState.lastSessionId || null,
      preferredModel: state.preferredModel,
      language: this.getLanguage(key),
      verboseOutput: Boolean(state.verboseOutput),
      ptySupported:
        this.config.runner.backend === "sdk" ? null : state.ptySupported,
      workdir: this.getWorkdir(key),
      relativeWorkdir: this.getRelativeWorkdir(key),
      workspaceRoot: this.config.workspace.root,
      command: this.config.runner.command,
      mcpServers: this.config.mcp.servers.map((server) => server.name),
      workflowSystem: "superpowers",
      workflowPhase: session
        ? (session.workflowPhase ?? "working")
        : (projectState.lastWorkflowPhase ?? "none")
    };
  }

  setPreferredModel(chatId: string | number, model: string): string | null {
    const state = this.ensureChatState(chatId);
    state.preferredModel = model?.trim() || null;
    this.onChange?.(this.exportState());
    return state.preferredModel;
  }

  clearPreferredModel(chatId: string | number): void {
    const state = this.ensureChatState(chatId);
    state.preferredModel = null;
    this.onChange?.(this.exportState());
  }
}
