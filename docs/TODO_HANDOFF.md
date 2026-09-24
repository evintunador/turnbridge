# Handoff and TODO

Spun out of [POLICY_SPLIT.md](POLICY_SPLIT.md) and
[LINEAGE_AND_COMPOUNDING.md](LINEAGE_AND_COMPOUNDING.md), 2026-08-13, revised
2026-08-23. Items are
split by whether the design is settled enough to hand to another agent.

---

## A. Annals extension ownership — SETTLED UPSTREAM

The authoritative contract is in annals' README, under **What annals owns,
and what it refuses to own** and **The envelope**. Annals owns storage; the
producer owns meaning. A third-party kind is identified by
`(producer.tool, kind)`,
`producer.version` names its vocabulary revision, and the producer publishes
the reader for that vocabulary. Annals deliberately provides no registration
or discovery mechanism.

For `turnbridge`'s `continuation` kind, `readLineage` and
`ContinuationRecord` are that public reader. Consumers such as context-graph
must import the reader rather than parse `content` themselves. The annals
filters needed by consumers (`kind: string | string[]`, `tool`, and `linkRel`)
are already available through cledger's unchanged public read surface.

## B. Stays with us: still design-entangled

Not ready for handoff — each is blocked on a decision in the companion docs.

- **Per-turn origin rendering** (LINEAGE_AND_COMPOUNDING §3, §3a). Blocked on
  the as-recorded vs. as-it-would-have-been call, and on adding
  `source_event_ids` to the `continuation` payload first, without which the
  walk cannot resolve a turn to its origin precisely (fabrication breaks
  positional correspondence three ways).
- **Move human-facing disclosure out of the transcript into `plan.notes`**,
  which already prints to the terminal and never enters model context. Applies
  to model substitution, ancestor-unavailable, and size reporting. The import
  notice is the one disclosure that genuinely belongs in context.
- **Probe whether Claude's `system` / `attachment` line types reach model
  context** (`docs/specs/claude-session-format.md:74`, `:196`). The two specs
  disagree: claude-session-format calls attachments "purely informational, not
  needed for resume"; cledger's `context_injection` describes them as material
  inserted into the model's context. If they do reach context, the import
  notice stops being a counterfeit user turn.
- **Read `producer.model` / `producer.provider`** instead of `actor.id`
  (LINEAGE_AND_COMPOUNDING §1). Independent of everything else, small, and
  strictly better input for opencode's provider resolution, which currently
  guesses by string-splitting the model id.

---

## C. TODO for Evin: Gemini and Qwen awareness

**Not urgent. Live but untested as of cledger 0.21.0.**

cledger 0.21.0 added `gemini-cli` and `qwen-code` capture adapters. turnbridge
consumes it via `file:../conversation-ledger`, so this is already in effect.

What happens today, unverified:

- Those conversations **appear in the picker**. `listConversations` has no
  source filter — `conversations.ts:72` takes `producer.source` verbatim.
- They render with a **raw source label**, since `cliLabel` falls through to
  the bare string for unknown names (`types.ts:21`).
- They can be **bridged out of** but never **into**: `buildPlan` native-resumes
  only when `target.name === summary.source` (`resume.ts:109`), which can never
  match, so they always fabricate. `parseCliName` also rejects them as target
  arguments.

So bridging *out* of Gemini/Qwen may already work as a free feature — a source
needs no adapter, only a target does — but it is silently one-way and has never
been exercised. Decide whether to (a) verify and document it as supported,
(b) add real target adapters, or (c) filter unsupported sources out of the
picker until one of those happens.
