import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceEvent } from "conversation-ledger";
import { resolveLineageHistory } from "../lineage-resolution.js";
import type { ContinuationRecord, Lineage } from "../lineage.js";
import { importSourceLabel, type ConversationSummary } from "../types.js";

function event(id: string, stream: string, seq: number, occurredAt: string, text: string): EvidenceEvent {
  return {
    id,
    schema: "annals/v1",
    kind: "conversation_turn",
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    actor: text.startsWith("assistant:") ? { type: "agent" } : { type: "human" },
    producer: { tool: "cledger", source: stream.split(":")[0]!, session_id: stream },
    stream: { id: stream, seq },
    content: {
      role: text.startsWith("assistant:") ? "assistant" : "user",
      blocks: [{ type: "text", text: text.replace(/^assistant:/, "") }],
    },
  };
}

function summary(id: string, events: EvidenceEvent[]): ConversationSummary {
  return {
    id,
    source: id.split(":")[0]!,
    sessionId: id.split(":").slice(1).join(":"),
    title: id,
    firstActivity: events[0]!.occurred_at,
    lastActivity: events[events.length - 1]!.occurred_at,
    turnCount: events.length,
    owners: [],
    ownerDisplays: [],
    events,
  };
}

function reasoning(id: string, stream: string, seq: number, occurredAt: string): EvidenceEvent {
  return {
    ...event(id, stream, seq, occurredAt, "assistant:"),
    kind: "reasoning",
    content: { opaque: true },
    raw: {
      format: "codex-rollout-jsonl/2",
      data: { type: "response_item", payload: { type: "reasoning", encrypted_content: "ENC" } },
    },
  };
}

function record(
  source: string,
  target: string,
  occurredAt: string,
  sourceEventIds?: string[],
  importedThroughSeq = 1,
): ContinuationRecord {
  return {
    source,
    target,
    importedThroughSeq,
    ...(sourceEventIds ? { sourceEventIds } : {}),
    targetCli: target.split(":")[0]!,
    occurredAt,
  };
}

function graph(records: ContinuationRecord[]): Lineage {
  const parentOf = new Map(records.map((item) => [item.target, item]));
  const childrenOf = new Map<string, ContinuationRecord[]>();
  for (const item of records) {
    const children = childrenOf.get(item.source) ?? [];
    children.push(item);
    childrenOf.set(item.source, children);
  }
  return { parentOf, childrenOf };
}

const A = "claude-code:a";
const B = "codex:b";
const C = "opencode:c";
const a1 = event("ev2-a1", A, 0, "2026-01-01T00:00:00.000Z", "original question");
const a2 = event("ev2-a2", A, 1, "2026-01-01T00:01:00.000Z", "assistant:original answer");
const bNotice = event(
  "ev2-bn",
  B,
  0,
  "2026-01-31T23:59:59.000Z",
  "[turnbridge import notice] stale notice",
);
const b1 = event("ev2-b1", B, 1, a1.occurred_at, "degraded question copy");
const b2 = event("ev2-b2", B, 2, a2.occurred_at, "assistant:degraded answer copy");
const b3 = event("ev2-b3", B, 3, "2026-02-02T00:00:00.000Z", "continued in Codex");
const cNotice = event(
  "ev2-cn",
  C,
  0,
  "2026-02-28T23:59:59.000Z",
  "[turnbridge import notice] another stale notice",
);
const c1 = event("ev2-c1", C, 1, a1.occurred_at, "second-generation copy");
const c2 = event("ev2-c2", C, 2, a2.occurred_at, "assistant:second-generation copy");
const c3 = event("ev2-c3", C, 3, b3.occurred_at, "copied Codex continuation");
const c4 = event("ev2-c4", C, 4, "2026-03-02T00:00:00.000Z", "continued in OpenCode");

test("multi-hop rendering uses flattened origin events and one origin chain", () => {
  const a = summary(A, [a1, a2]);
  const b = summary(B, [bNotice, b1, b2, b3]);
  const c = summary(C, [cNotice, c1, c2, c3, c4]);
  const lineage = graph([
    record(A, B, "2026-02-01T00:00:00.000Z", [a1.id, a2.id]),
    record(B, C, "2026-03-01T00:00:00.000Z", [a1.id, a2.id, b3.id], 3),
  ]);

  const resolved = resolveLineageHistory(c, [a, b, c], lineage);
  assert.deepEqual(resolved.summary.events.map((item) => item.id), [a1.id, a2.id, b3.id, c4.id]);
  assert.deepEqual(resolved.summary.lineageSources, ["claude-code", "codex", "opencode"]);
  assert.equal(importSourceLabel(resolved.summary), "Claude Code → Codex → OpenCode");
  assert.deepEqual(resolved.notes, []);
});

test("unavailable origins fall back to the captured copy and disclose it", () => {
  const b = summary(B, [bNotice, b1, b2, b3]);
  const lineage = graph([
    record(A, B, "2026-02-01T00:00:00.000Z", [a1.id, "ev2-missing"]),
  ]);

  const resolved = resolveLineageHistory(b, [b], lineage);
  assert.deepEqual(resolved.summary.events.map((item) => item.id), [b1.id, b2.id, b3.id]);
  assert.equal(resolved.notes.length, 1);
  assert.match(resolved.notes[0]!, /original events.*unavailable.*captured copy/);
});

test("legacy lineage without source ids resolves through the source seq boundary", () => {
  const a = summary(A, [a1, a2]);
  const b = summary(B, [bNotice, b1, b2, b3]);
  const lineage = graph([record(A, B, "2026-02-01T00:00:00.000Z")]);

  const resolved = resolveLineageHistory(b, [a, b], lineage);
  assert.deepEqual(resolved.summary.events.map((item) => item.id), [a1.id, a2.id, b3.id]);
  assert.deepEqual(resolved.notes, []);
});

test("a later capable target recovers reasoning dropped by an intermediate target", () => {
  const codex = "codex:reasoning-origin";
  const claude = "claude-code:reasoning-copy";
  const question = event("ev2-rq", codex, 0, "2026-04-01T00:00:00.000Z", "why?");
  const hidden = reasoning("ev2-rr", codex, 1, "2026-04-01T00:00:01.000Z");
  const answer = event("ev2-ra", codex, 2, "2026-04-01T00:00:02.000Z", "assistant:because");
  const origin = summary(codex, [question, hidden, answer]);
  const copy = summary(claude, [
    event("ev2-rn", claude, 0, "2026-04-30T23:59:59.000Z", "[turnbridge import notice]"),
    event("ev2-rc1", claude, 1, question.occurred_at, "why?"),
    event("ev2-rc2", claude, 2, answer.occurred_at, "assistant:because"),
  ]);
  const lineage = graph([
    // Claude could not render the opaque event, so it is absent from the
    // rendered-id list; the source snapshot still preserves it for Codex.
    record(codex, claude, "2026-05-01T00:00:00.000Z", [question.id, answer.id], 2),
  ]);

  const resolved = resolveLineageHistory(copy, [origin, copy], lineage);
  assert.deepEqual(resolved.summary.events.map((item) => item.id), [
    question.id,
    hidden.id,
    answer.id,
  ]);
});
