import { spawn } from "node:child_process";
import process from "node:process";
import simpleGit from "simple-git";
import { Octokit } from "@octokit/rest";
import { parseCommandLine } from "../../runner/commandLine.js";
import { t } from "../../bot/i18n.js";

function buildAutoCommitMessage(status) {
  const fileCount = status.files.length;
  const preview = status.files
    .slice(0, 3)
    .map((item) => item.path)
    .join(", ");
  return `chore: update ${fileCount} file(s)${preview ? ` (${preview})` : ""}`;
}

function extractQuotedMessage(text) {
  const matched = text.match(/["“](.+?)["”]/);
  return matched?.[1]?.trim() || "";
}

function extractRepoName(text) {
  const patterns = [
    /(?:创建仓库|create repo(?:sitory)?|repo)\s*[:：]?\s*([a-zA-Z0-9._-]+)/i,
    /(?:仓库名|repository)\s*[:：]?\s*([a-zA-Z0-9._-]+)/i
  ];

  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched?.[1]) return matched[1];
  }

  return "";
}

function pickJobId(text, fallbackJobId) {
  const matched = text.match(/(?:job|任务|#)\s*([a-zA-Z0-9-]+)/i);
  return matched?.[1] || fallbackJobId;
}

export class GitHubSkill {
  constructor({ config }) {
    this.config = config;
    this.octokit = config.github.token ? new Octokit({ auth: config.github.token }) : null;
    this.testJobs = new Map();
    this.latestTestJobId = "";
  }

  getGit(workdir) {
    return simpleGit({
      baseDir: workdir || this.config.github.defaultWorkdir
    });
  }

  supports(text) {
    const normalized = text.toLowerCase();
    return (
      normalized.startsWith("/gh") ||
      /github|git push|git commit|提交|推送|创建仓库|playwright|测试状态|run test|运行测试/.test(normalized)
    );
  }

  async execute({ text, workdir, locale = "en" }) {
    const stripped = text.replace(/^\/gh(@\w+)?\s*/i, "").trim();
    const normalized = stripped.toLowerCase();

    if (!stripped || normalized === "help") {
      return { text: this.helpText(locale) };
    }

    if (/创建仓库|create repo|new repo/.test(normalized)) {
      return this.createRepoFromText(stripped, workdir, locale);
    }

    if (/测试状态|test status|status/.test(normalized)) {
      return this.readTestStatusFromText(stripped, locale);
    }

    if (/运行测试|run test|playwright|e2e/.test(normalized)) {
      return this.startTests(workdir, locale);
    }

    if ((/推送|\bpush\b/.test(normalized) && !/提交|commit/.test(normalized))) {
      return this.pushOnly(workdir, locale);
    }

    if (/提交|推送|commit|push/.test(normalized)) {
      return this.commitAndPush(stripped, workdir, locale);
    }

    return { text: this.helpText(locale) };
  }

  helpText(locale = "en") {
    return t(locale, "githubHelp");
  }

  async commitAndPush(rawText, workdir, locale = "en") {
    const git = this.getGit(workdir);
    const status = await git.status();
    if (!status.files.length) {
      return { text: t(locale, "githubNoChanges") };
    }

    const explicitMessage = extractQuotedMessage(rawText);
    const commitMessage = explicitMessage || buildAutoCommitMessage(status);

    await git.add(".");
    await git.commit(commitMessage);

    const branchInfo = await git.branch();
    const branch = branchInfo.current || this.config.github.defaultBranch;

    try {
      await git.push("origin", branch);
      return {
        text: t(locale, "githubCommitAndPushSucceeded", {
          workdir: workdir || this.config.github.defaultWorkdir,
          branch,
          message: commitMessage
        })
      };
    } catch (error) {
      return {
        text: t(locale, "githubCommitSucceededPushFailed", {
          workdir: workdir || this.config.github.defaultWorkdir,
          branch,
          message: commitMessage,
          error: error.message
        })
      };
    }
  }

  async pushOnly(workdir, locale = "en") {
    const git = this.getGit(workdir);
    const branchInfo = await git.branch();
    const branch = branchInfo.current || this.config.github.defaultBranch;
    await git.push("origin", branch);
    return {
      text: t(locale, "githubPushSucceeded", {
        workdir: workdir || this.config.github.defaultWorkdir,
        branch
      })
    };
  }

  async createRepoFromText(rawText, workdir, locale = "en") {
    if (!this.octokit) {
      return { text: t(locale, "githubMissingToken") };
    }

    const repoName = extractRepoName(rawText);
    if (!repoName) {
      return { text: t(locale, "githubRepoNameParseFailed") };
    }

    const git = this.getGit(workdir);
    const isPrivate = !/public|公开/.test(rawText.toLowerCase());
    const { data: repo } = await this.octokit.repos.createForAuthenticatedUser({
      name: repoName,
      private: isPrivate,
      auto_init: false
    });

    const remotes = await git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === "origin");
    if (!origin) {
      await git.addRemote("origin", repo.clone_url);
    } else {
      await git.remote(["set-url", "origin", repo.clone_url]);
    }

    const branchInfo = await git.branch();
    const branch = branchInfo.current || this.config.github.defaultBranch;

    await git.push(["-u", "origin", branch]);

    return {
      text: t(locale, "githubRepoCreated", {
        workdir: workdir || this.config.github.defaultWorkdir,
        repo: repo.full_name,
        url: repo.html_url,
        branch
      })
    };
  }

  async startTests(workdir, locale = "en") {
    const jobId = `job-${Date.now()}`;
    const command = this.config.github.e2eCommand;
    const argv = parseCommandLine(command);
    if (!argv.length) {
      return { text: t(locale, "githubEmptyTestCommand") };
    }

    const [binary, ...args] = argv;
    const job = {
      jobId,
      status: "running",
      workdir: workdir || this.config.github.defaultWorkdir,
      command,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      exitCode: null,
      output: ""
    };

    const child = spawn(binary, args, {
      cwd: workdir || this.config.github.defaultWorkdir,
      env: process.env,
      shell: false
    });

    const appendOutput = (chunk) => {
      job.output = `${job.output}${chunk}`;
      if (job.output.length > 5000) {
        job.output = job.output.slice(-5000);
      }
    };

    child.stdout.on("data", (chunk) => appendOutput(String(chunk)));
    child.stderr.on("data", (chunk) => appendOutput(String(chunk)));
    child.on("close", (exitCode) => {
      job.status = exitCode === 0 ? "passed" : "failed";
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();
    });
    child.on("error", (error) => {
      job.status = "failed";
      job.exitCode = -1;
      job.finishedAt = new Date().toISOString();
      appendOutput(`\n[spawn error] ${error.message}`);
    });

    this.testJobs.set(jobId, job);
    this.latestTestJobId = jobId;

    return {
      text: t(locale, "githubTestsStarted", {
        jobId,
        workdir: job.workdir,
        command
      }),
      testJobId: jobId
    };
  }

  async readTestStatusFromText(text, locale = "en") {
    const targetJobId = pickJobId(text, this.latestTestJobId);
    if (!targetJobId) {
      return { text: t(locale, "githubNoTestJobs") };
    }

    const job = this.testJobs.get(targetJobId);
    if (!job) {
      return { text: t(locale, "githubTestJobNotFound", { jobId: targetJobId }) };
    }

    return {
      text: t(locale, "githubTestStatus", { job }),
      testJobId: job.jobId
    };
  }

  async getTestStatus(jobId = this.latestTestJobId, locale = "en") {
    if (!jobId) return null;
    return this.readTestStatusFromText(`test status ${jobId}`, locale);
  }
}
