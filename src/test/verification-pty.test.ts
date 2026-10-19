import assert from "node:assert/strict";
import test from "node:test";
import { runPty } from "../verification/pty.js";
import { isolatedEnvironment } from "../verification/process.js";

test("verification environment excludes parent credentials and session settings", () => {
  const env = isolatedEnvironment("/tmp/turnbridge-isolation", "/usr/bin:/bin");
  assert.equal(env.HOME, "/tmp/turnbridge-isolation");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

test("PTY delivers ordered input through a real terminal", async () => {
  const result = await runPty("python3", ["-c", "import sys; print('READY' if sys.stdin.isatty() else 'NO_TTY',flush=True); print('GOT:'+input(),flush=True)"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 3000,
    actions: [{ waitFor: "READY", send: "TESTONLY-input\r" }],
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.actionsCompleted, 1);
  assert.match(result.output, /GOT:TESTONLY-input/);
});

test("PTY deadlines stop stalled processes without inventing completed actions", async () => {
  const result = await runPty("python3", ["-c", "import time; print('WRONG',flush=True); time.sleep(30)"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 200,
    actions: [{ waitFor: "EXPECTED", send: "never\r" }],
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.actionsCompleted, 0);
});

test("PTY preserves Unicode even when a native process splits UTF-8 bytes", async () => {
  const result = await runPty("python3", ["-c", "import os,time; data='日本語 🦉'.encode(); [(os.write(1,bytes([b])),time.sleep(.015)) for b in data]"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 3000, actions: [],
  });
  assert.equal(result.code, 0);
  assert.match(result.output, /日本語 🦉/);
  assert(!result.output.includes("�"));
});

test("legacy PTY does not advertise Kitty keyboard support before sending ordinary Enter", async () => {
  const native = "import os,select,tty; tty.setraw(0); os.write(1,b'\\x1b[?u'); ready,_,_=select.select([0],[],[],.2); assert not ready, 'unexpected keyboard protocol advertisement'; os.write(1,b'READY'); assert os.read(0,1)==b'\\r'; os.write(1,b'ENTER_OK')";
  const result = await runPty("python3", ["-c", native], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 3000,
    actions: [{ waitFor: "READY", send: "\r" }],
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /ENTER_OK/);
});
