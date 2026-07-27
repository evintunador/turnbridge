# Product intent

## Purpose

Turnbridge lets a developer continue a visible coding conversation in a
different agent CLI when they choose to switch providers or tools. It retains
the full user-visible turn history—messages, tool calls, and tool results—
rather than requiring a last-minute summary from a rate-limited model.

It serves two users who are often the same person on different days: a solo
developer hopping CLIs mid-task (rate limits, model choice), and small
collaborating groups whose members use *different* CLIs and want to pick up
each other's conversations. Sharing rides on Conversation Ledger's git-notes
storage; each turn is attributed to its human author via the repo's git
identity, and listings show only your own (plus unattributed) conversations
unless you ask for everyone's.

## Behavioral commitments

- Capture every available visible turn incrementally, not only on clean exit
  (delivered by Conversation Ledger's hooks; see division below).
- Preserve source content faithfully and label its originating CLI.
- Offer one resume picker across supported CLIs while making the session type
  honest: native resume for same-CLI records, native-format fabrication for
  cross-CLI records, transcript rehydration as the always-available fallback.
- Prefer conversations whose repository and code state match the current work;
  warn rather than silently treating mismatched history as current.
- Never claim to transfer hidden reasoning, private provider state, or an
  exact native session; a fabricated session is labeled as imported. The one
  exception is verifiably real, not claimed: a Codex-origin conversation
  fabricated back into Codex replays its provider-encrypted `reasoning`
  blobs verbatim by default (never across CLIs — ciphertext can't be forged
  as a foreign CLI's native reasoning), and the import notice discloses
  exactly how many blocks were replayed so the label stays honest either way.
  `--no-reasoning-replay` / `{"reasoningReplay": false}` opts out.
- Put the developer in control of capture, sharing, and deletion. Sharing is
  a deliberate choice, not a side effect: today it is an explicit
  `cledger sync`; the decided direction (see Conversation Ledger's design
  doc) is optional-but-default-on transport hooks so records ride normal
  `git push`/`pull`, gated by the ledger's secret scan and disableable per
  user. Listings default to the current user's records.

## Non-goals

- A team presence system, task tracker, or agent orchestration framework.
- Inferring or replacing human intent.
- Summarized "handoff notes" (sticky-note-style); Turnbridge moves the literal
  record.

## Relationship to Conversation Ledger

Turnbridge is a client of Conversation Ledger, which owns the durable neutral
record **and** the source-CLI capture adapters (hooks, transcript parsers,
cursors, dedup). Turnbridge owns everything on the resume side: the unified
picker, ownership/compatibility filtering, target-CLI session fabrication,
bootstrap rehydration, and the optional command shims.
