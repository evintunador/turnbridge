import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "../resume.js";
import { readLineage } from "../lineage.js";
import { targets } from "../targets/index.js";
import { FabricationUnsupportedError } from "../targets/types.js";
import { writeBootstrapTranscript } from "../bootstrap.js";
import { listConversations } from "../conversations.js";
import { cleanupRepo, makeTempRepo, seedConversation } from "./helpers.js";

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function withTurnbridgeHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "turnbridge-bootstrap-test-"));
  const prev = process.env["TURNBRIDGE_HOME"];
  process.env["TURNBRIDGE_HOME"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["TURNBRIDGE_HOME"];
    else process.env["TURNBRIDGE_HOME"] = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("writes the transcript under <configDir>/bootstrap, sanitizing the conversation id", async () => {
  await withTurnbridgeHome(async (home) => {
    const repo = await makeTempRepo();
    try {
      await seedConversation(repo, `codex:${SID}`, "codex", [
        { role: "user", text: "hello there", seq: 0, email: "me@x.com" },
        { role: "assistant", text: "hi back", seq: 1 },
      ]);
      const [summary] = await listConversations(repo, { all: true });
      const result = await writeBootstrapTranscript(summary!);

      assert.ok(result.path.startsWith(join(home, "bootstrap")));
      assert.ok(result.path.endsWith(".md"));
      // conversation id is `codex:<uuid>`; the colon must not survive into the filename
      assert.ok(!result.path.includes(":"), "id separator must be sanitized out of the filename");

      const written = await readFile(result.path, "utf8");
      assert.match(written, /# Conversation imported from Codex/);
      assert.match(written, /hello there/);
      assert.match(written, /hi back/);

      assert.equal(result.size.characters, written.length);
      assert.equal(result.size.bytes, Buffer.byteLength(written, "utf8"));
      assert.ok(result.size.characters > 0);
    } finally {
      await cleanupRepo(repo);
    }
  });
});

test("each bootstrap gets an immutable isolated transcript instead of overwriting another session's context", async () => {
  await withTurnbridgeHome(async () => {
    const repo = await makeTempRepo();
    try {
      await seedConversation(repo, `codex:${SID}`, "codex", [
        { role: "user", text: "first pass", seq: 0, email: "me@x.com" },
      ]);
      const [summary] = await listConversations(repo, { all: true });
      const first = await writeBootstrapTranscript(summary!);
      const second = await writeBootstrapTranscript(summary!);
      assert.notEqual(first.path, second.path);
      assert.equal(await readFile(first.path, "utf8"), await readFile(second.path, "utf8"));

      const written = await readFile(second.path, "utf8");
      assert.equal((written.match(/first pass/g) ?? []).length, 1);
    } finally {
      await cleanupRepo(repo);
    }
  });
});

test("reported size grows with a larger transcript", async () => {
  await withTurnbridgeHome(async () => {
    const repo = await makeTempRepo();
    try {
      await seedConversation(repo, `codex:${SID}`, "codex", [
        { role: "user", text: "short", seq: 0, email: "me@x.com" },
      ]);
      const [small] = await listConversations(repo, { all: true });
      const smallResult = await writeBootstrapTranscript(small!);

      const SID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await seedConversation(repo, `codex:${SID2}`, "codex", [
        { role: "user", text: "a".repeat(2000), seq: 0, email: "me@x.com" },
      ]);
      const all = await listConversations(repo, { all: true });
      const big = all.find((c) => c.sessionId === SID2)!;
      const bigResult = await writeBootstrapTranscript(big);

      assert.ok(bigResult.size.characters > smallResult.size.characters);
    } finally {
      await cleanupRepo(repo);
    }
  });
});


test("environmental native import failures retain their cause through a disclosed bootstrap fallback", async () => {
  await withTurnbridgeHome(async () => {
    const repo = await makeTempRepo();
    try {
      await seedConversation(repo, `codex:${SID}`, "codex", [{ role: "user", text: "keep this visible history", seq: 0 }]);
      const convs = await listConversations(repo, { all: true });
      const target = { ...targets.pi, async fabricate() { throw new FabricationUnsupportedError("models failed (ETIMEDOUT)", "pi", "environment"); } };
      const plan = await buildPlan(repo, target, convs[0]!, repo.root, false, await readLineage(repo), convs, false);
      assert.deepEqual(plan.nativeImportFallback, { kind: "environment", reason: "models failed (ETIMEDOUT)" });
      assert.equal(plan.fabricatedConversationId, undefined);
      assert(plan.notes.some(note => note.includes("NEW")));
      assert.match(await readFile(plan.notes.find(note => note.startsWith("transcript: "))!.slice("transcript: ".length), "utf8"), /keep this visible history/);
    } finally { await cleanupRepo(repo); }
  });
});
