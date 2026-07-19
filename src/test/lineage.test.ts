import assert from "node:assert/strict";
import test from "node:test";
import { readLineage, recordContinuation } from "../lineage.js";
import { renderConversationRow } from "../resume.js";
import { listConversations } from "../conversations.js";
import { cleanupRepo, makeTempRepo, seedConversation } from "./helpers.js";

const SRC = "claude-code:66666666-6666-4666-8666-666666666666";
const TGT = "codex:77777777-7777-4777-8777-777777777777";

test("records and reads a continuation edge in both directions", async () => {
  const repo = await makeTempRepo();
  try {
    await recordContinuation(repo, {
      source: SRC,
      target: TGT,
      importedThroughSeq: 41,
      targetCli: "codex",
      version: "0.1.0",
    });
    const lineage = await readLineage(repo);
    const parent = lineage.parentOf.get(TGT);
    assert.ok(parent);
    assert.equal(parent!.source, SRC);
    assert.equal(parent!.importedThroughSeq, 41);
    assert.equal(lineage.childrenOf.get(SRC)!.length, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("annotates rows: source shows bridged-to, target shows continued-from", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, SRC, "claude-code", [
      { role: "user", text: "start here", seq: 0, email: "me@x.com" },
    ]);
    await seedConversation(repo, TGT, "codex", [
      { role: "user", text: "[turnbridge import notice] ...", seq: 0, email: "me@x.com" },
      { role: "user", text: "keep going in codex", seq: 1, email: "me@x.com" },
    ]);
    await recordContinuation(repo, {
      source: SRC,
      target: TGT,
      importedThroughSeq: 0,
      targetCli: "codex",
      version: "0.1.0",
    });

    const lineage = await readLineage(repo);
    const convs = await listConversations(repo, { all: true });
    const bySource = new Map(convs.map((c) => [c.id, c]));

    const srcRow = renderConversationRow(bySource.get(SRC)!, 0, "me@x.com", lineage);
    const tgtRow = renderConversationRow(bySource.get(TGT)!, 1, "me@x.com", lineage);
    assert.match(srcRow, /→ bridged to Codex/);
    assert.match(tgtRow, /↳ continued from Claude Code/);
  } finally {
    await cleanupRepo(repo);
  }
});
