import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanPrompt,
  extractCommandPayload,
  suggestClosestWord
} from "../src/bot/commandUtils.js";

test("extractCommandPayload removes telegram command prefix and bot suffix", () => {
  assert.equal(extractCommandPayload("/exec@ExampleBot run tests", "exec"), "run tests");
  assert.equal(extractCommandPayload("/model gpt-5-codex", "model"), "gpt-5-codex");
  assert.equal(extractCommandPayload("/new", "new"), "");
});

test("buildPlanPrompt forces planning-only behavior", () => {
  const prompt = buildPlanPrompt("refactor src/index.js");

  assert.match(prompt, /Planning mode only/);
  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /Task:\nrefactor src\/index\.js/);
});

test("suggestClosestWord returns the nearest supported command when the typo is small", () => {
  assert.equal(suggestClosestWord("ststus", ["list", "status", "tools"]), "status");
  assert.equal(suggestClosestWord("zzz", ["list", "status", "tools"]), "");
});
