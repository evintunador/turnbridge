import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildGeminiImport } from "../targets/gemini.js";
import type { ConversationSummary } from "../types.js";

test("Gemini native history uses text records without inventing foreign executable calls", () => {
  const summary = { source: "codex", events: [
    { kind: "conversation_turn", id: "user", occurred_at: "1970-01-01T00:00:00Z", content: { role: "user", blocks: [{ type: "text", text: "café 日本語 🦉" }] } },
    { kind: "conversation_turn", id: "answer", occurred_at: "2026-01-01T00:00:01Z", content: { role: "assistant", blocks: [{ type: "tool_use", name: "foreign_exec", input: { cmd: "never execute" } }, { type: "thinking", text: "visible thought" }] } },
    { kind: "reasoning", id: "hidden", occurred_at: "2026-01-01T00:00:02Z", content: { opaque: "do not replay" } },
  ] } as unknown as ConversationSummary;
  const payload = buildGeminiImport(summary, "test-session", "/fixture", new Date("2026-01-02T00:00:00Z"));
  const lines = payload.lines as Array<Record<string, unknown>>;
  assert.deepEqual(payload.importedSourceEventIds, ["user", "answer"]);
  assert.equal(lines[0]!.sessionId, "test-session");
  assert.equal(lines[0]!.projectHash, createHash("sha256").update("/fixture").digest("hex"));
  assert.equal(lines[2]!.timestamp, "1970-01-01T00:00:00.000Z");
  assert.equal(lines[3]!.type, "gemini");
  assert.match(JSON.stringify(payload.lines), /café 日本語 🦉/);
  assert.match(JSON.stringify(payload.lines), /foreign_exec.*never execute/);
  assert.match(JSON.stringify(payload.lines), /visible thought/);
  assert.doesNotMatch(JSON.stringify(payload.lines), /functionCall|toolCalls|opaque|do not replay/);
});
