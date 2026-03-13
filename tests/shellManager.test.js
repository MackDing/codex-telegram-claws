import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandLine } from "../src/runner/commandLine.js";
import { ShellManager } from "../src/runner/shellManager.js";

function createShellManager(overrides = {}) {
  return new ShellManager({
    config: {
      shell: {
        enabled: overrides.enabled ?? true,
        readOnly: overrides.readOnly ?? true,
        allowedCommands: overrides.allowedCommands ?? ["pwd", "git status", "npm test"],
        dangerousCommands: overrides.dangerousCommands ?? ["git push", "git commit"],
        timeoutMs: overrides.timeoutMs ?? 5000,
        maxOutputChars: overrides.maxOutputChars ?? 4000
      }
    }
  });
}

test("parseCommandLine keeps quoted arguments together", () => {
  assert.deepEqual(parseCommandLine("git commit -m 'feat: init repo'"), [
    "git",
    "commit",
    "-m",
    "feat: init repo"
  ]);
});

test("shell manager rejects shell metacharacters and commands outside the allowlist", () => {
  const manager = createShellManager();

  assert.throws(
    () => manager.validateCommand("git status && pwd"),
    /Pipes, redirection, command substitution/
  );
  assert.throws(() => manager.validateCommand("rm -rf ."), /Command is not allowlisted/);
});

test("shell manager marks dangerous commands for confirmation when writable", () => {
  const manager = createShellManager({
    readOnly: false,
    allowedCommands: ["git push", "git status"]
  });

  const inspection = manager.inspectCommand("git push");

  assert.equal(inspection.dangerous, true);
  assert.equal(inspection.requiresConfirmation, true);
  assert.equal(inspection.confirmationCommand, "/sh --confirm git push");
});

test("shell manager blocks dangerous commands in read-only mode", () => {
  const manager = createShellManager({
    readOnly: true,
    allowedCommands: ["git push", "git status"]
  });

  assert.throws(() => manager.inspectCommand("git push"), /currently read-only/);
});

test("shell manager allows confirmed dangerous commands when writable", () => {
  const manager = createShellManager({
    readOnly: false,
    allowedCommands: ["git push", "git status"]
  });

  const inspection = manager.inspectCommand("--confirm git push");

  assert.equal(inspection.requiresConfirmation, false);
  assert.deepEqual(inspection.argv, ["git", "push"]);
});

test("shell manager executes an allowed command without invoking a shell", async () => {
  const manager = createShellManager({
    allowedCommands: ["pwd"]
  });
  const workdir = path.join(os.tmpdir());

  const result = await manager.execute({
    chatId: 1,
    rawCommand: "pwd",
    workdir
  });

  assert.equal(result.started, true);
  assert.equal(result.status, "passed");
  assert.equal(result.workdir, workdir);
  assert.match(result.output, new RegExp(workdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("shell manager reports disabled mode before execution", () => {
  const manager = createShellManager({
    enabled: false
  });

  assert.throws(
    () => manager.validateCommand("pwd"),
    /Restricted shell is not enabled/
  );
});

test("shell manager localizes validation errors when locale is zh", () => {
  const manager = createShellManager({
    enabled: false
  });

  assert.throws(() => manager.validateCommand("pwd", { locale: "zh" }), /受限 Shell 功能未启用/);
});
