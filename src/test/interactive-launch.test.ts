import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPty } from "../verification/pty.js";
import type { LaunchPlan } from "../targets/types.js";

test("typing after bootstrap paste cancels the production relay's pending Enter", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "turnbridge-relay-input-")));
  try {
    const native = "import os,select,time,tty; tty.setraw(0); os.write(1,b'COMPOSER_READY'); data=b''\nwhile b'\\x1b[201~' not in data: data+=os.read(0,4096)\nos.write(1,data+b'PASTE_OBSERVED'); end=time.monotonic()+.7; user=b''\nwhile time.monotonic()<end:\n ready,_,_=select.select([0],[],[],.03)\n if ready: user+=os.read(0,4096)\nassert b'x' in user, user\nassert b'\\r' not in user, 'automatic Enter raced user typing'\nos.write(1,b'USER_OWNS_COMPOSER')";
    const plan: LaunchPlan = { command: "python3", args: ["-c", native], cwd: root, notes: [],
      initialInput: { prompt: "TESTONLY bootstrap prompt", readiness: "COMPOSER_READY" } };
    const path = join(root, "launch.json");
    await writeFile(path, JSON.stringify(plan));
    const result = await runPty(process.execPath, [fileURLToPath(new URL("../verification/launch.js", import.meta.url)), path], {
      cwd: root, env: { PATH: process.env.PATH, TERM: "xterm-256color" }, timeoutMs: 5000,
      actions: [{ waitFor: "PASTE_OBSERVED", send: "x", delayMs: 25 }],
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /USER_OWNS_COMPOSER/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
