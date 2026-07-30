/**
 * Timestamp normalization for fabricated session files.
 *
 * Source timestamps reach us verbatim: each CLI writes its own `timestamp`
 * onto every transcript line, and conversation-ledger copies that string into
 * `occurred_at` unchanged, validating it only with `Date.parse` — which
 * accepts second precision, offset forms like `+00:00`, and other shapes
 * neither CLI actually emits today. Both Claude Code and Codex write
 * millisecond-precision UTC `...Z` strings as of the pinned versions, and that
 * is the only form either resume path has been verified against, so we
 * re-emit every timestamp in exactly that form rather than passing an
 * unverified shape through into a fabricated file.
 *
 * This normalizes representation only. The instant is preserved, and real
 * event times are never reordered or clamped — they are evidence, not
 * cosmetics. See docs/specs/claude-session-format.md §7.
 */

/** Millisecond-precision UTC (`2026-07-21T06:36:04.414Z`), as both CLIs emit. */
export function normalizeTimestamp(value: string, fallback: Date): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return fallback.toISOString();
  return new Date(ms).toISOString();
}

/** True when `timestamps` never steps backward (equal adjacent values are fine). */
export function isNonDecreasing(timestamps: string[]): boolean {
  for (let i = 1; i < timestamps.length; i++) {
    const prev = Date.parse(timestamps[i - 1]!);
    const cur = Date.parse(timestamps[i]!);
    if (Number.isNaN(prev) || Number.isNaN(cur)) return false;
    if (cur < prev) return false;
  }
  return true;
}
