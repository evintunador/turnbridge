import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceEvent } from "conversation-ledger";
import { formatSize, renderTranscript, transcriptSize } from "../transcript.js";
import { turnContent, type ConversationSummary } from "../types.js";

let seq = 0;

/**
 * A minimal, fully-formed EvidenceEvent. turnContent/renderTranscript only
 * read `.content` and `.actor`, but the type requires the rest — filled with
 * inert placeholders. No ledger/git IO involved; both functions under test
 * are pure over their inputs.
 */
function makeEvent(
  content: unknown,
  opts: { human?: boolean; display?: string; modelId?: string } = {},
): EvidenceEvent {
  const n = seq++;
  const ts = `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
  return {
    id: `ev1-test-${n}`,
    schema: "conversation-ledger/v1",
    kind: "conversation_turn",
    occurred_at: ts,
    recorded_at: ts,
    actor: opts.human
      ? { type: "human", ...(opts.display ? { display: opts.display } : {}) }
      : { type: "agent", ...(opts.modelId ? { id: opts.modelId } : {}) },
    producer: { tool: "test", source: "codex", session_id: "test-session" },
    conversation: { id: "codex:test-session", seq: n },
    content,
  };
}

function makeSummary(events: EvidenceEvent[]): ConversationSummary {
  return {
    id: "codex:test-session",
    source: "codex",
    sessionId: "test-session",
    title: "test",
    firstActivity: events[0]?.occurred_at ?? "2026-01-01T00:00:00.000Z",
    lastActivity: events[events.length - 1]?.occurred_at ?? "2026-01-01T00:00:00.000Z",
    turnCount: events.length,
    owners: [],
    ownerDisplays: [],
    events,
  };
}

// --- turnContent (types.ts) ---

test("turnContent parses a well-formed payload", () => {
  const content = turnContent(makeEvent({ role: "user", blocks: [{ type: "text", text: "hi" }] }));
  assert.deepEqual(content, { role: "user", blocks: [{ type: "text", text: "hi" }] });
});

test("turnContent returns null for non-object content", () => {
  assert.equal(turnContent(makeEvent("just a string")), null);
  assert.equal(turnContent(makeEvent(null)), null);
  assert.equal(turnContent(makeEvent(42)), null);
});

test("turnContent returns null when role is missing or not a string", () => {
  assert.equal(turnContent(makeEvent({ blocks: [] })), null);
  assert.equal(turnContent(makeEvent({ role: 5, blocks: [] })), null);
});

test("turnContent returns null when blocks is missing or not an array", () => {
  assert.equal(turnContent(makeEvent({ role: "user", blocks: "nope" })), null);
  assert.equal(turnContent(makeEvent({ role: "user" })), null);
});

test("turnContent accepts an empty blocks array", () => {
  assert.deepEqual(turnContent(makeEvent({ role: "user", blocks: [] })), { role: "user", blocks: [] });
});

// --- renderTranscript block-type branches (transcript.ts) ---

test("renders a tool_use block as a labeled JSON call", () => {
  const md = renderTranscript(
    makeSummary([
      makeEvent({ role: "assistant", blocks: [{ type: "tool_use", name: "run_tests", input: { path: "./" } }] }),
    ]),
  );
  assert.match(md, /\*\*Tool call:\*\* `run_tests`/);
  assert.match(md, /"path": "\.\/"/);
});

test("renders a tool_use block with no name/input using safe defaults", () => {
  const md = renderTranscript(makeSummary([makeEvent({ role: "assistant", blocks: [{ type: "tool_use" }] })]));
  assert.match(md, /\*\*Tool call:\*\* `unknown`/);
  assert.match(md, /```json\n\{\}\n```/);
});

test("renders a tool_result block with string content under a 'Tool result' heading", () => {
  const md = renderTranscript(
    makeSummary([makeEvent({ role: "tool_result", blocks: [{ type: "tool_result", content: "42 passed" }] })]),
  );
  assert.match(md, /## Tool result/);
  assert.match(md, /\*\*Tool result:\*\*/);
  assert.match(md, /42 passed/);
});

test("renders a tool_result block with non-string content as JSON", () => {
  const md = renderTranscript(
    makeSummary([makeEvent({ role: "tool_result", blocks: [{ type: "tool_result", content: { ok: true } }] })]),
  );
  assert.match(md, /"ok": true/);
});

test("renders a thinking block quoted and labeled", () => {
  const md = renderTranscript(
    makeSummary([makeEvent({ role: "assistant", blocks: [{ type: "thinking", text: "step 1\nstep 2" }] })]),
  );
  assert.match(md, /> \[thinking\]/);
  assert.match(md, /> step 1/);
  assert.match(md, /> step 2/);
});

test("an empty thinking block renders nothing (filtered out)", () => {
  const md = renderTranscript(
    makeSummary([
      makeEvent({ role: "assistant", blocks: [{ type: "thinking", text: "" }] }),
      makeEvent({ role: "assistant", blocks: [{ type: "text", text: "kept" }] }),
    ]),
  );
  assert.ok(!md.includes("[thinking]"));
  assert.match(md, /kept/);
});

test("renders an unrecognized block type as a raw JSON blob", () => {
  const md = renderTranscript(
    makeSummary([makeEvent({ role: "assistant", blocks: [{ type: "custom_widget", foo: "bar" }] })]),
  );
  assert.match(md, /```json/);
  assert.match(md, /"type": "custom_widget"/);
  assert.match(md, /"foo": "bar"/);
});

test("an event whose only block renders empty text is skipped entirely", () => {
  const md = renderTranscript(
    makeSummary([
      makeEvent({ role: "user", blocks: [{ type: "text", text: "" }] }, { human: true, display: "Me" }),
      makeEvent({ role: "user", blocks: [{ type: "text", text: "real message" }] }, { human: true, display: "Me" }),
    ]),
  );
  assert.equal((md.match(/## User \(Me\)/g) ?? []).length, 1);
  assert.match(md, /real message/);
});

test("an event with malformed content (turnContent -> null) is skipped", () => {
  const md = renderTranscript(
    makeSummary([
      makeEvent("not an object with role/blocks"),
      makeEvent({ role: "user", blocks: [{ type: "text", text: "kept" }] }, { human: true }),
    ]),
  );
  assert.match(md, /kept/);
  assert.equal((md.match(/^## /gm) ?? []).length, 1);
});

test("an event with zero blocks is skipped entirely", () => {
  const md = renderTranscript(
    makeSummary([
      makeEvent({ role: "user", blocks: [] }, { human: true }),
      makeEvent({ role: "user", blocks: [{ type: "text", text: "kept" }] }, { human: true }),
    ]),
  );
  assert.equal((md.match(/^## /gm) ?? []).length, 1);
  assert.match(md, /kept/);
});

test("assistant heading includes the model id when present", () => {
  const md = renderTranscript(
    makeSummary([
      makeEvent({ role: "assistant", blocks: [{ type: "text", text: "hi" }] }, { modelId: "gpt-test" }),
    ]),
  );
  assert.match(md, /## Assistant \(gpt-test\)/);
});

// --- transcriptSize / formatSize ---

test("transcriptSize reports characters and utf8 bytes, not a token guess", () => {
  assert.deepEqual(transcriptSize(""), { characters: 0, bytes: 0 });
  assert.deepEqual(transcriptSize("abcd"), { characters: 4, bytes: 4 });
  // multi-byte content: characters and bytes legitimately diverge
  assert.deepEqual(transcriptSize("héllo→"), { characters: 6, bytes: 9 });
});

test("formatSize renders KB below a megabyte and MB above it", () => {
  assert.match(formatSize(transcriptSize("a".repeat(2048))), /^2,048 characters \(~2 KB\)$/);
  assert.match(formatSize(transcriptSize("a".repeat(2 * 1024 * 1024))), /\(~2\.0 MB\)$/);
});
