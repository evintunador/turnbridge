import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredModels } from "../targets/opencode.js";

test("configured model discovery uses the selected CLI and tolerates invalid debug output", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnbridge-model-config-"));
  try {
    const binary = join(root, "kilo-fixture");
    await writeFile(binary, `#!${process.execPath}
const { readFileSync } = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'debug config') process.exit(1);
process.stdout.write(readFileSync('config.json', 'utf8'));
`, { mode: 0o700 });
    await writeFile(join(root, "config.json"), JSON.stringify({ model: "global/default", agent: { build: { model: "agent/preferred" } } }));
    assert.deepEqual(configuredModels(root, binary), ["agent/preferred", "global/default"]);
    for (const invalid of ["null", "[]", "not json", '{"model":123,"agent":{"build":{"model":false}}}']) {
      await writeFile(join(root, "config.json"), invalid);
      assert.deepEqual(configuredModels(root, binary), []);
    }
    assert.deepEqual(configuredModels(root, join(root, "missing-cli")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
