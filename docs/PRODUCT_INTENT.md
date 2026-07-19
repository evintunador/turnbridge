# Product intent

## Purpose

Turnbridge lets a developer continue a visible coding conversation in a
different agent CLI when they choose to switch providers or tools. It should
retain the full user-visible turn history—messages, tool calls, and tool
results—rather than requiring a last-minute summary from a rate-limited model.

## Behavioral commitments

- Capture every available visible turn incrementally, not only on clean exit.
- Preserve source content faithfully and label its originating CLI.
- Offer one resume picker across supported CLIs while making the session type
  honest: native resume where possible, transcript rehydration otherwise.
- Prefer conversations whose repository and code state match the current work;
  warn rather than silently treating mismatched history as current.
- Never claim to transfer hidden reasoning, private provider state, or an
  exact native session.
- Put the developer in control of capture, sharing, and deletion.

## Non-goals

- A team presence system, task tracker, or agent orchestration framework.
- Inferring or replacing human intent.
- Depending on undocumented native session-file writes as its core mechanism.

## Relationship to Conversation Ledger

Turnbridge is a client of Conversation Ledger. It owns CLI-specific adapters
and rehydration behavior; Conversation Ledger owns the durable neutral record.

Existing local transcript parsers should be reused where they are a good fit.
They are adapters, not the canonical format: Turnbridge supplies the cursoring,
partial-turn handling, and cross-CLI behavior those parsers do not promise.
