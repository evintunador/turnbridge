import assert from "node:assert/strict";
import test from "node:test";
import { renderConversationRow } from "../resume.js";
import type { ConversationSummary } from "../types.js";

/** renderConversationRow is a pure function of a ConversationSummary — no ledger needed. */
function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  const now = new Date().toISOString();
  return {
    id: "codex:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source: "codex",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "example conversation",
    firstActivity: now,
    lastActivity: now,
    turnCount: 2,
    owners: [],
    ownerDisplays: [],
    events: [],
    ...overrides,
  };
}

test("unknown-author row shows 'by author unknown'", () => {
  // owners.length === 0 sets owner to the literal string "author unknown",
  // which is then truthy and gets the same "by " prefix as a real owner.
  const row = renderConversationRow(summary({ owners: [], ownerDisplays: [] }), 0, "me@x.com");
  assert.match(row, /by author unknown/);
});

test("self-owned row omits the owner annotation entirely", () => {
  const row = renderConversationRow(
    summary({ owners: ["me@x.com"], ownerDisplays: ["Me"] }),
    0,
    "me@x.com",
  );
  assert.ok(!row.includes("by "));
  assert.ok(!row.includes("author unknown"));
});

test("collaborator-owned row shows the collaborator's display name", () => {
  const row = renderConversationRow(
    summary({ owners: ["them@x.com"], ownerDisplays: ["Them"] }),
    0,
    "me@x.com",
  );
  assert.match(row, /by Them/);
});

test("collaborator-owned row without a display name falls back to the raw email", () => {
  const row = renderConversationRow(
    summary({ owners: ["them@x.com"], ownerDisplays: [] }),
    0,
    "me@x.com",
  );
  assert.match(row, /by them@x\.com/);
});

test("mixed ownership (self + collaborator) still shows a 'by' annotation", () => {
  const row = renderConversationRow(
    summary({ owners: ["me@x.com", "them@x.com"], ownerDisplays: ["Me", "Them"] }),
    0,
    "me@x.com",
  );
  assert.match(row, /by /);
});

// relativeTime is private to resume.ts; exercised indirectly through the
// rendered row. Boundaries are computed relative to Date.now() at call time
// with a wide enough margin to stay deterministic under normal test latency.

test("relativeTime: sub-minute activity reads 'just now'", () => {
  const row = renderConversationRow(
    summary({ lastActivity: new Date(Date.now() - 10_000).toISOString() }),
    0,
    null,
  );
  assert.match(row, /just now/);
});

test("relativeTime: minutes-ago range", () => {
  const row = renderConversationRow(
    summary({ lastActivity: new Date(Date.now() - 5 * 60_000).toISOString() }),
    0,
    null,
  );
  assert.match(row, /\d+m ago/);
});

test("relativeTime: hours-ago range", () => {
  const row = renderConversationRow(
    summary({ lastActivity: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
    0,
    null,
  );
  assert.match(row, /\d+h ago/);
});

test("relativeTime: just under the 48h cutoff still reads hours-ago", () => {
  const row = renderConversationRow(
    summary({ lastActivity: new Date(Date.now() - 47 * 3_600_000).toISOString() }),
    0,
    null,
  );
  assert.match(row, /\d+h ago/);
});

test("relativeTime: past the 48h cutoff reads days-ago", () => {
  const row = renderConversationRow(
    summary({ lastActivity: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    0,
    null,
  );
  assert.match(row, /\d+d ago/);
});

test("relativeTime: an unparsable timestamp is passed through verbatim", () => {
  const row = renderConversationRow(summary({ lastActivity: "not-a-date" }), 0, null);
  assert.match(row, /not-a-date/);
});

test("index is rendered as a 1-based bracketed position", () => {
  const row = renderConversationRow(summary(), 4, null);
  assert.match(row, /^\[5\]/);
});

test("title is always appended, prefixed by a middle dot", () => {
  const row = renderConversationRow(summary({ title: "fix the flaky test" }), 0, null);
  assert.match(row, /· fix the flaky test$/);
});
