import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const eslintConfigUrl = new URL("../eslint.config.ts", import.meta.url);
const ecosystemConfigUrl = new URL("../ecosystem.config.ts", import.meta.url);

test("eslint config shim resolves the typescript source of truth", async () => {
  const [{ default: tsConfig }, { default: jsConfig }] = await Promise.all([
    import(eslintConfigUrl.href),
    import("../eslint.config.js")
  ]);

  assert.equal(Array.isArray(tsConfig), true);
  assert.equal(Array.isArray(jsConfig), true);
  assert.equal(jsConfig.length, tsConfig.length);
  const tsLastConfig = tsConfig.at(-1);
  const jsLastConfig = jsConfig.at(-1);
  const tsFiles =
    tsLastConfig && "files" in tsLastConfig ? tsLastConfig.files : [];
  const jsFiles =
    jsLastConfig && "files" in jsLastConfig ? jsLastConfig.files : [];
  assert.deepEqual(jsFiles, tsFiles);
});

test("ecosystem config points pm2 at the typescript runtime entry", async () => {
  const { default: tsConfig } = await import(ecosystemConfigUrl.href);
  const cjsConfig = require("../ecosystem.config.cjs");

  assert.equal(tsConfig.apps[0]?.script, "src/index.ts");
  assert.equal(tsConfig.apps[0]?.interpreter, "node_modules/.bin/tsx");
  assert.equal(cjsConfig.apps[0]?.script, tsConfig.apps[0]?.script);
  assert.equal(cjsConfig.apps[0]?.interpreter, tsConfig.apps[0]?.interpreter);
});
