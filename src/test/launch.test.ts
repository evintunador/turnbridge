import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryOnPath, runLaunchPlan } from "../launch.js";
import type { LaunchPlan } from "../targets/types.js";

/** A throwaway executable shell script, never a real claude/codex binary. */
async function withFakeBin<T>(script: string, fn: (path: string, dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "turnbridge-launch-test-"));
  const path = join(dir, "fake-cli");
  await writeFile(path, script);
  await chmod(path, 0o755);
  try {
    return await fn(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Capture writes to a stream's `.write` method for the duration of `fn`. */
async function captureWrites<T>(
  stream: NodeJS.WriteStream,
  fn: () => Promise<T> | T,
): Promise<{ result: T; writes: string[] }> {
  const writes: string[] = [];
  const original = stream.write.bind(stream);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).write = original;
  }
}

test("binaryOnPath finds a real executable and rejects a nonexistent one", async () => {
  assert.equal(await binaryOnPath("node"), true);
  assert.equal(await binaryOnPath("definitely-not-a-real-binary-turnbridge-xyz"), false);
});

test("runLaunchPlan writes each note to stderr before spawning", async () => {
  await withFakeBin("#!/bin/sh\nexit 0\n", async (path, dir) => {
    const plan: LaunchPlan = { command: path, args: [], cwd: dir, notes: ["note one", "note two"] };
    const { result: code, writes } = await captureWrites(process.stderr, () => runLaunchPlan(plan));
    assert.equal(code, 0);
    assert.ok(writes.some((w) => w.includes("turnbridge: note one")));
    assert.ok(writes.some((w) => w.includes("turnbridge: note two")));
  });
});

test("runLaunchPlan returns the spawned command's exit code", async () => {
  await withFakeBin("#!/bin/sh\nexit 7\n", async (path, dir) => {
    const plan: LaunchPlan = { command: path, args: [], cwd: dir, notes: [] };
    assert.equal(runLaunchPlan(plan), 7);
  });
});

test("runLaunchPlan passes args and cwd through to the spawned command", async () => {
  await withFakeBin(
    '#!/bin/sh\necho "$@" > "$(dirname "$0")/out.txt"\npwd >> "$(dirname "$0")/out.txt"\n',
    async (path, dir) => {
      const plan: LaunchPlan = { command: path, args: ["--resume", "abc-123"], cwd: dir, notes: [] };
      const code = runLaunchPlan(plan);
      assert.equal(code, 0);
      const out = (await readFile(join(dir, "out.txt"), "utf8")).trim().split("\n");
      assert.equal(out[0], "--resume abc-123");
      assert.equal(await realpath(out[1]!), await realpath(dir));
    },
  );
});

test("runLaunchPlan reports a launch failure and returns 1 when the command cannot be found", async () => {
  const plan: LaunchPlan = {
    command: join(tmpdir(), "turnbridge-test-no-such-binary-xyz"),
    args: [],
    cwd: tmpdir(),
    notes: [],
  };
  const { result: code, writes } = await captureWrites(process.stderr, () => runLaunchPlan(plan));
  assert.equal(code, 1);
  assert.ok(writes.some((w) => w.includes("failed to launch")));
});
