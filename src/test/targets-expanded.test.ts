import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_CLIS, parseCliName, type ConversationSummary } from "../types.js";
import { targets } from "../targets/index.js";
import { FabricationUnsupportedError } from "../targets/types.js";
import { BOOTSTRAP_SYNTAX } from "../targets/bootstrap-targets.js";

const summary: ConversationSummary = { id: "codex:source", sessionId: "source", source: "codex", title: "test", firstActivity: "2026-01-01", lastActivity: "2026-01-01", turnCount: 0, owners: [], ownerDisplays: [], events: [] };

test("all roster targets offer an honest interactive bootstrap route", () => {
  assert.equal(SUPPORTED_CLIS.length, 20);
  for (const name of SUPPORTED_CLIS) {
    const target = targets[name], plan = target.bootstrap(summary, "/tmp/repo", "/tmp/history.md");
    assert.equal(plan.cwd, "/tmp/repo");
    assert(plan.notes.some(note => note.includes("NEW")));
    assert((plan.initialInput?.prompt ?? plan.args.join(" ")).includes("/tmp/history.md"));
    assert(!plan.args.includes("run") || plan.command === "cledger", `${name}: must not use native headless run`);
  }
  assert.equal(parseCliName("gemini"), "gemini-cli");
  assert.equal(parseCliName("cn"), "continue");
  assert.equal(parseCliName("claude_code"), "claude-code");
});

test("bootstrap-only targets never pretend to fabricate native history", async () => {
  for (const name of SUPPORTED_CLIS.filter(name => BOOTSTRAP_SYNTAX[name] && targets[name].supportsNativeImport === false)) {
    await assert.rejects(targets[name].fabricate(summary, "/tmp/repo", { replayReasoning: false }), FabricationUnsupportedError);
    if (targets[name].supportsNativeResume === false) assert.throws(() => targets[name].nativeResume("exact-id", "/tmp/repo"), FabricationUnsupportedError);
  }
});
