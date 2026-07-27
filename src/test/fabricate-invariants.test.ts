import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationSummary } from "../types.js";
import { buildSessionLines } from "../targets/claude-code.js";
import { buildRolloutLines } from "../targets/codex.js";
import { isNonDecreasing, normalizeTimestamp } from "../timestamps.js";
import { turnDraft } from "./helpers.js";

/**
 * Invariants the format specs call out as "untested — recommend always doing
 * X" (docs/specs/claude-session-format.md §7). turnbridge already satisfies
 * them by construction; these lock that in so a refactor can't quietly
 * regress into the undefined-behavior territory the specs warn about.
 */

const NOW = new Date("2026-07-27T12:00:00.000Z");

function summaryOf(
  source: string,
  turns: Array<{ role: "user" | "assistant"; text: string; occurredAt?: string }>,
): ConversationSummary {
  const id = `${source}:11111111-2222-3333-4444-555555555555`;
  const events = turns.map((t, i) =>
    turnDraft(id, source, {
      role: t.role,
      text: t.text,
      seq: i + 1,
      ...(t.occurredAt ? { occurredAt: t.occurredAt } : {}),
    }),
  );
  return {
    id,
    source,
    sessionId: id.split(":").slice(1).join(":"),
    turnCount: turns.length,
    firstActivity: events[0]?.occurred_at ?? NOW.toISOString(),
    lastActivity: events[events.length - 1]?.occurred_at ?? NOW.toISOString(),
    events,
  } as unknown as ConversationSummary;
}

const SAMPLE = summaryOf("codex", [
  { role: "user", text: "first question" },
  { role: "assistant", text: "first answer" },
  { role: "user", text: "second question" },
]);

test("normalizeTimestamp re-emits every accepted form as millisecond UTC", () => {
  // conversation-ledger validates occurred_at with Date.parse only, so these
  // all survive capture even though neither CLI emits them today.
  assert.equal(normalizeTimestamp("2026-07-21T06:36:04.414Z", NOW), "2026-07-21T06:36:04.414Z");
  assert.equal(normalizeTimestamp("2026-07-21T06:36:04Z", NOW), "2026-07-21T06:36:04.000Z");
  assert.equal(normalizeTimestamp("2026-07-21T08:36:04.414+02:00", NOW), "2026-07-21T06:36:04.414Z");
  // unparseable input must not produce an invalid timestamp in a session file
  assert.equal(normalizeTimestamp("not a date", NOW), NOW.toISOString());
});

test("claude: every line carries a millisecond-precision UTC timestamp", () => {
  const summary = summaryOf("codex", [
    { role: "user", text: "q", occurredAt: "2026-07-21T06:36:04Z" },
    { role: "assistant", text: "a", occurredAt: "2026-07-21T08:36:05.5+02:00" },
  ]);
  const lines = buildSessionLines(summary, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "/repo", "2.1.215", NOW);
  for (const line of lines) {
    assert.match(
      line.timestamp,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      `non-normalized timestamp written: ${line.timestamp}`,
    );
  }
});

test("codex: every line carries a millisecond-precision UTC timestamp", () => {
  const summary = summaryOf("claude-code", [
    { role: "user", text: "q", occurredAt: "2026-07-21T06:36:04Z" },
    { role: "assistant", text: "a", occurredAt: "2026-07-21T08:36:05.5+02:00" },
  ]);
  const lines = buildRolloutLines(summary, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "/repo", "0.144.6", NOW);
  for (const line of lines) {
    assert.match(
      line.timestamp,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      `non-normalized timestamp written: ${line.timestamp}`,
    );
  }
});

test("claude: history lines preserve source order and never reorder real events", () => {
  const lines = buildSessionLines(SAMPLE, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "/repo", "2.1.215", NOW);
  // line 0 is turnbridge's synthetic import notice, stamped at fabrication
  // time; see the comment in buildSessionLines about why it is not backdated.
  const history = lines.slice(1).map((l) => l.timestamp);
  assert.ok(isNonDecreasing(history), `history went backward: ${history.join(", ")}`);
});

test("claude: sessionId field matches the filename id on every line (spec §7)", () => {
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lines = buildSessionLines(SAMPLE, sessionId, "/repo", "2.1.215", NOW);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.equal(line.sessionId, sessionId);
});

test("claude: uuids are unique and parentUuid chains without dangling refs (spec §7)", () => {
  const lines = buildSessionLines(SAMPLE, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "/repo", "2.1.215", NOW);
  const seen = new Set<string>();
  let expectedParent: string | null = null;
  for (const line of lines) {
    assert.equal(seen.has(line.uuid), false, `duplicate uuid ${line.uuid}`);
    seen.add(line.uuid);
    assert.equal(line.parentUuid, expectedParent, "parentUuid must chain to the previous line");
    if (line.parentUuid !== null) {
      assert.ok(seen.has(line.parentUuid), `dangling parentUuid ${line.parentUuid}`);
    }
    expectedParent = line.uuid;
  }
  assert.equal(seen.size, lines.length);
});
