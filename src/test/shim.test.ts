import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shimDir, shimInstall, shimStatus, shimUninstall } from "../shim.js";

const RC_MARKER = "# added by `turnbridge shim install`";

interface ShimEnv {
  home: string;
  binDir: string;
}

/**
 * Isolates shim.ts's two real-filesystem touchpoints:
 *  - HOME, which os.homedir() reads live, so ~/.zshrc becomes <fakeHome>/.zshrc
 *  - TURNBRIDGE_HOME, which configDir() (and therefore shimDir()) reads directly
 *  - PATH, restricted to /usr/bin:/bin (so `which` itself still resolves) plus
 *    an optional temp bin dir seeded with fake `claude`/`codex` executables —
 *    never the real CLIs, which this dev machine may well have installed.
 */
async function withShimEnv<T>(
  opts: { seedBinaries?: boolean },
  fn: (env: ShimEnv) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "turnbridge-shim-home-"));
  const turnbridgeHome = await mkdtemp(join(tmpdir(), "turnbridge-shim-th-"));
  const binDir = await mkdtemp(join(tmpdir(), "turnbridge-shim-bin-"));

  if (opts.seedBinaries) {
    for (const name of ["claude", "codex"]) {
      const p = join(binDir, name);
      await writeFile(p, `#!/bin/sh\necho fake-${name}\n`);
      await chmod(p, 0o755);
    }
  }

  const prevHome = process.env["HOME"];
  const prevTh = process.env["TURNBRIDGE_HOME"];
  const prevPath = process.env["PATH"];

  process.env["HOME"] = home;
  process.env["TURNBRIDGE_HOME"] = turnbridgeHome;
  process.env["PATH"] = opts.seedBinaries ? `${binDir}:/usr/bin:/bin` : "/usr/bin:/bin";

  try {
    return await fn({ home, binDir });
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    if (prevTh === undefined) delete process.env["TURNBRIDGE_HOME"];
    else process.env["TURNBRIDGE_HOME"] = prevTh;
    if (prevPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = prevPath;
    await rm(home, { recursive: true, force: true });
    await rm(turnbridgeHome, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const result = await fn();
    return { result, out: writes.join("") };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const result = await fn();
    return { result, out: writes.join("") };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = original;
  }
}

test("shimStatus reports absent before install and points at the right shim dir", async () => {
  await withShimEnv({ seedBinaries: true }, async () => {
    const { result: code, out } = await captureStdout(() => shimStatus());
    assert.equal(code, 0);
    assert.match(out, /PATH entry in ~\/\.zshrc: absent/);
    assert.ok(out.includes(shimDir()));
  });
});

test("shimInstall writes both shims and adds a single PATH line to ~/.zshrc; reinstalling doesn't duplicate it", async () => {
  await withShimEnv({ seedBinaries: true }, async (env) => {
    const code = await shimInstall();
    assert.equal(code, 0);

    const claudeShimPath = join(shimDir(), "claude");
    const codexShimPath = join(shimDir(), "codex");
    const claudeShimContent = await readFile(claudeShimPath, "utf8");
    const codexShimContent = await readFile(codexShimPath, "utf8");

    assert.match(claudeShimContent, /exec turnbridge resume claude-code/);
    assert.ok(claudeShimContent.includes(join(env.binDir, "claude")));
    assert.match(codexShimContent, /exec turnbridge resume codex/);
    assert.ok(codexShimContent.includes(join(env.binDir, "codex")));

    const mode = (await stat(claudeShimPath)).mode & 0o777;
    assert.equal(mode, 0o755);

    const rc = await readFile(join(env.home, ".zshrc"), "utf8");
    assert.ok(rc.includes(RC_MARKER));
    assert.ok(rc.includes(`export PATH="${shimDir()}:$PATH"`));

    const { result: statusCode, out: statusOut } = await captureStdout(() => shimStatus());
    assert.equal(statusCode, 0);
    assert.match(statusOut, /PATH entry in ~\/\.zshrc: present/);

    // installing again must not duplicate the marker or the PATH export
    await shimInstall();
    const rcAfterSecondInstall = await readFile(join(env.home, ".zshrc"), "utf8");
    const markerCount = (rcAfterSecondInstall.match(/# added by `turnbridge shim install`/g) ?? []).length;
    assert.equal(markerCount, 1);
    const pathLineCount = (
      rcAfterSecondInstall.match(new RegExp(`export PATH="${shimDir()}`, "g")) ?? []
    ).length;
    assert.equal(pathLineCount, 1);
  });
});

test("shimInstall skips CLIs missing from PATH and returns 1 when neither is found", async () => {
  await withShimEnv({ seedBinaries: false }, async () => {
    const { result: code, out } = await captureStderr(() => shimInstall());
    assert.equal(code, 1);
    assert.match(out, /claude not found on PATH; skipping its shim/);
    assert.match(out, /codex not found on PATH; skipping its shim/);
  });
});

test("shimUninstall removes the shim dir and cleans only the turnbridge lines from ~/.zshrc", async () => {
  await withShimEnv({ seedBinaries: true }, async (env) => {
    await writeFile(join(env.home, ".zshrc"), "export FOO=bar\n");
    await shimInstall();

    const before = await readFile(join(env.home, ".zshrc"), "utf8");
    assert.ok(before.includes("FOO=bar"));
    assert.ok(before.includes(RC_MARKER));

    const code = await shimUninstall();
    assert.equal(code, 0);

    await assert.rejects(() => stat(shimDir()));

    const after = await readFile(join(env.home, ".zshrc"), "utf8");
    assert.ok(after.includes("FOO=bar"), "unrelated rc content must survive uninstall");
    assert.ok(!after.includes(RC_MARKER));
    assert.ok(!after.includes(`export PATH="${shimDir()}`));
  });
});

test("shimUninstall is safe with no prior install (no shim dir, no rc file)", async () => {
  await withShimEnv({ seedBinaries: true }, async () => {
    const code = await shimUninstall();
    assert.equal(code, 0);
  });
});
