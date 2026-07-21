import assert from "node:assert/strict";
import test from "node:test";
import { appendEvents, git, reAnchorDraft } from "conversation-ledger";
import { listConversations } from "../conversations.js";
import { withLedgerNotices } from "../ledger-io.js";
import { readLineage, recordContinuation } from "../lineage.js";
import { renderConversationRow } from "../resume.js";
import { cleanupRepo, makeCommit, makeTempRepo, seedConversation } from "./helpers.js";

const SRC = "claude-code:88888888-8888-4888-8888-888888888888";
const TGT = "codex:99999999-9999-4999-8999-999999999999";

/**
 * The squash-merge scenario through turnbridge's own read path: a bridged
 * conversation pair captured on a feature branch, branch squashed onto main
 * (simulated by an ordinary commit — establishing the mapping is cledger
 * detection's job, resolution is what turnbridge depends on), re_anchor
 * mapping anchored to the squash commit. Both the conversations and the
 * continuation edge must survive in the picker's HEAD-scoped view.
 */
test("bridged conversations and lineage survive a squash rewrite via re_anchor", async () => {
  const repo = await makeTempRepo();
  try {
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const featCommit = await makeCommit(repo, "feat work");
    await seedConversation(repo, SRC, "claude-code", [
      { role: "user", text: "start here", seq: 0, email: "me@x.com" },
    ]);
    await seedConversation(repo, TGT, "codex", [
      { role: "user", text: "keep going in codex", seq: 0, email: "me@x.com" },
    ]);
    await recordContinuation(repo, {
      source: SRC,
      target: TGT,
      importedThroughSeq: 0,
      targetCli: "codex",
      version: "0.1.0",
    });

    await git(["checkout", "-q", "main"], { cwd: repo.root });
    const squash = await makeCommit(repo, "feat squashed (#1)");

    // Baseline: the squash orphaned everything from HEAD's view.
    assert.equal((await listConversations(repo, { all: true })).length, 0);
    assert.equal((await readLineage(repo)).parentOf.size, 0);

    await appendEvents(
      repo,
      [
        reAnchorDraft({
          superseded: [featCommit],
          successor: squash,
          method: "patch-id",
          occurredAt: "2026-01-03T00:00:00.000Z",
          branch: "feat",
        }),
      ],
      { anchor: squash },
    );

    const convs = await listConversations(repo, { all: true });
    const lineage = await readLineage(repo);
    assert.deepEqual(convs.map((c) => c.id).sort(), [SRC, TGT]);
    assert.equal(lineage.parentOf.get(TGT)?.source, SRC);

    const bySource = new Map(convs.map((c) => [c.id, c]));
    const srcRow = renderConversationRow(bySource.get(SRC)!, 0, "me@x.com", lineage);
    const tgtRow = renderConversationRow(bySource.get(TGT)!, 1, "me@x.com", lineage);
    assert.match(srcRow, /→ bridged to Codex/);
    assert.match(tgtRow, /↳ continued from Claude Code/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("withLedgerNotices buffers stderr and re-emits it as one block", async () => {
  const original = process.stderr.write.bind(process.stderr);
  const emitted: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    emitted.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await withLedgerNotices(async () => {
      process.stderr.write("cledger: notice one\n");
      assert.equal(emitted.length, 0); // buffered, not yet emitted
      process.stderr.write("cledger: notice two");
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(emitted, ["cledger: notice one\ncledger: notice two\n"]);
  } finally {
    process.stderr.write = original;
  }
});

test("withLedgerNotices flushes buffered notices when the wrapped call throws", async () => {
  const original = process.stderr.write.bind(process.stderr);
  const emitted: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    emitted.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    await assert.rejects(
      withLedgerNotices(async () => {
        process.stderr.write("cledger: partial work\n");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(emitted, ["cledger: partial work\n"]);
  } finally {
    process.stderr.write = original;
  }
});
