import assert from "node:assert/strict";
import test from "node:test";
import { buildTextImport } from "../targets/text-import.js";
import type { ConversationSummary } from "../types.js";

const summary = {
  source: "codex", lineageSources: ["claude-code", "codex"], events: [
    { kind: "conversation_turn", id: "one", occurred_at: "2026-01-01T00:00:00Z", content: { role: "user", blocks: [{ type: "text", text: "Hello café 日本語 🦉" }] } },
    { kind: "conversation_turn", id: "two", occurred_at: "2026-01-01T00:00:01Z", content: { role: "assistant", blocks: [{ type: "tool_use", name: "foreign_exec", input: { command: "never run this" } }, { type: "thinking", text: "visible thought" }] } },
    { kind: "conversation_turn", id: "three", occurred_at: "2026-01-01T00:00:02Z", content: { role: "user", blocks: [{ type: "attachment_reference", sha256: "abc", size: 42, media_type: "image/png", retention: "embedded_not_retained" }] } },
    { kind: "reasoning", id: "opaque", occurred_at: "2026-01-01T00:00:03Z", content: { opaque: true } },
  ],
} as unknown as ConversationSummary;

for (const target of ["pi", "qwen-code"] as const) test(`${target} import keeps Unicode and structured text without forging executable calls`, () => {
  const payload = buildTextImport(summary, target, "session-id", "/fixture", "1.2.3");
  const text = JSON.stringify(payload.lines);
  assert.match(text, /Hello café 日本語 🦉/);
  assert.match(text, /foreign_exec/);
  assert.match(text, /attachment_reference/);
  assert.match(text, /embedded_not_retained/);
  assert.match(text, /Claude Code → Codex/);
  assert.doesNotMatch(text, /toolCall|functionCall/);
  assert.deepEqual(payload.importedSourceEventIds, ["one", "two", "three"]);
  const messages = payload.lines.filter(line => line.type !== "session") as Record<string, unknown>[];
  const ids = messages.map(line => line[target === "pi" ? "id" : "uuid"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(messages[0]![target === "pi" ? "parentId" : "parentUuid"], null);
  for (let i = 1; i < messages.length; i++) assert.equal(messages[i]![target === "pi" ? "parentId" : "parentUuid"], ids[i - 1]);
});
