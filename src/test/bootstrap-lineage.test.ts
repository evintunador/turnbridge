import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { listConversations } from "../conversations.js";
import { readLineage } from "../lineage.js";
import { recordPendingBootstrap, reconcileBootstrapContinuations } from "../bootstrap-lineage.js";
import { resolveLineageHistory } from "../lineage-resolution.js";
import { makeTempRepo, cleanupRepo, seedConversation } from "./helpers.js";

test("late bootstrap capture links exact sessions and restores history across hops", async () => {
  const repo = await makeTempRepo(), token = randomUUID();
  try {
    await seedConversation(repo, "codex:origin", "codex", [{ role: "user", text: "original context", seq: 0 }]);
    const before = await listConversations(repo, { all: true });
    await recordPendingBootstrap(repo, { token, source: "codex:origin", targetCli: "qwen-code", importedThroughSeq: 0,
      sourceEventIds: before[0]!.events.map(e => e.id), version: "test" });
    assert.equal(await reconcileBootstrapContinuations(repo), 0);
    await seedConversation(repo, "qwen-code:child", "qwen-code", [
      { role: "user", text: `[turnbridge bootstrap ${token}] fresh session`, seq: 0, occurredAt: new Date().toISOString() },
      { role: "assistant", text: "context loaded", seq: 1, occurredAt: new Date().toISOString() },
      { role: "user", text: "new work", seq: 2, occurredAt: new Date().toISOString() },
    ]);
    assert.equal(await reconcileBootstrapContinuations(repo), 1);
    assert.equal(await reconcileBootstrapContinuations(repo), 0);
    const lineage = await readLineage(repo, true), convs = await listConversations(repo, { all: true });
    const child = convs.find(s => s.id === "qwen-code:child")!;
    const restored = resolveLineageHistory(child, convs, lineage).summary;
    const text = JSON.stringify(restored.events);
    assert.match(text, /original context/);
    assert.match(text, /new work/);
    assert.doesNotMatch(text, /fresh session/);
    assert.equal(lineage.parentOf.get(child.id)?.mode, "bootstrap");
  } finally { await cleanupRepo(repo); }
});

test("ambiguous copied bootstrap markers do not attach arbitrary sessions", async () => {
  const repo = await makeTempRepo(), token = randomUUID();
  try {
    await recordPendingBootstrap(repo, { token, source: "codex:origin", targetCli: "pi", importedThroughSeq: 0, sourceEventIds: [], version: "test" });
    for (const id of ["pi:a", "pi:b"]) await seedConversation(repo, id, "pi", [{ role: "user", text: `[turnbridge bootstrap ${token}]`, seq: 0 }]);
    assert.equal(await reconcileBootstrapContinuations(repo), 0);
    assert.equal((await readLineage(repo, true)).parentOf.size, 0);
  } finally { await cleanupRepo(repo); }
});
