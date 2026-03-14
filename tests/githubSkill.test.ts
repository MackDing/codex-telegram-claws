import test from "node:test";
import assert from "node:assert/strict";
import { GitHubSkill } from "../src/orchestrator/skills/githubSkill.js";

function createGitHubConfig() {
  return {
    github: {
      token: "",
      defaultWorkdir: process.cwd(),
      defaultBranch: "main",
      e2eCommand: "npm test"
    }
  };
}

test("github skill returns no-job text when test status is requested before any run", async () => {
  const skill = new GitHubSkill({
    config: createGitHubConfig()
  });

  const result = await skill.readTestStatusFromText("test status", "en");

  assert.match(result.text, /No test jobs|no test jobs/i);
});

test("github skill returns commit-and-push success text from a stub git client", async () => {
  const skill = new GitHubSkill({
    config: createGitHubConfig()
  });

  skill.getGit = () => ({
    status: async () => ({
      files: [{ path: "src/index.ts" }]
    }),
    add: async () => {},
    commit: async () => {},
    branch: async () => ({
      current: "main"
    }),
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    remote: async () => {}
  });

  const result = await skill.commitAndPush(
    '/gh commit "feat: migrate"',
    process.cwd(),
    "en"
  );

  assert.match(result.text, /Commit and push succeeded/);
  assert.match(result.text, /feat: migrate/);
});
