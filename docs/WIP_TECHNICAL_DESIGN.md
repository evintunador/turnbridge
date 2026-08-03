# WIP technical design

**Status:** MVP implemented for Claude Code ⇄ Codex; fabrication adapters are
version-pinned and must be revalidated per CLI release.

## Main flow

1. Conversation Ledger's hooks (`cledger install all`) capture each CLI's
   local transcript incrementally into git notes as normalized
   `conversation_turn` events, stamped with the repo's git identity
   (`actor.id` = `user.email`) on human turns.
2. `turnbridge resume [claude|codex]` lists conversations compatible with the
   current repository state: events anchored to commits reachable from `HEAD`
   (`--any-commit` lifts this), authored by you or unattributed
   (`--all` includes collaborators).
3. Selecting a conversation whose source matches the target CLI delegates to
   that CLI's native resume.
4. Cross-CLI selections default to **native fabrication**: turnbridge writes a
   target-native session file from the canonical events and launches the
   target's own resume on it. `--bootstrap` (also the automatic fallback when
   fabrication is unsupported or fails validation) starts a fresh target
   session whose first prompt instructs it to read the literal transcript.

## Module map

- `src/conversations.ts` — ledger read + grouping + ownership/compat filter.
- `src/resume.ts` — picker flow, target choice, default-target config.
- `src/targets/*` — per-CLI `TargetAdapter`: `nativeResume`, `fabricate`,
  `bootstrap`. Fabrication throws `FabricationUnsupportedError` to trigger the
  fallback.
- `src/transcript.ts` + `src/bootstrap.ts` — literal markdown rendering and
  the rehydration prompt; reports estimated token size before launch.
- `src/shim.ts` — opt-in PATH shims: bare `claude --resume` / `codex resume`
  open the merged picker; everything else passes through to the real binary.

## Division of labor with Conversation Ledger

The ledger owns capture (adapters, cursors, idempotent event ids, git-notes
storage, transport). Turnbridge never parses source transcripts itself and
is a reader plus a writer of *target-native* session files. It writes exactly
one kind of ledger event — `continuation` lineage edges (below) — and no
conversation content. Ledger changes made for turnbridge: a library entry
point (`package.json` exports) and human-turn identity stamping.

Turnbridge's reads inherit cledger 0.8.0's read-time behavior: `readEvents()`
lazily absorbs whatever transport already fetched into the local ref, then
auto-runs squash/rebase re-anchor detection, which can append a `re_anchor`
mapping event and print a notice to stderr. Reachability filtering resolves
through `re_anchor` mappings, so a bridged conversation and its `continuation`
lineage survive a squash merge instead of falling out of the picker. Turnbridge
issues two such reads per invocation (conversation listing, then lineage
lookup) and buffers the ledger's stderr notices across both so they render as
one block above the picker rather than interleaving with it.

## Conversation lineage (branch-on-bridge)

Bridging is a fork, not a move. Fabricating a target session writes a real
native file; when the user continues there, the target CLI captures it as a
new conversation whose id is the session id turnbridge generated (verified:
Codex resume preserves the id and appends). The source conversation still
exists, so both are resumable — a genuine branch, like a git fork.

To keep that honest instead of confusing, at fabricate time turnbridge appends
a `continuation` event (`links: [{rel:"continues", target:<source>}]`, content
carries `imported_through_seq`) belonging to the target conversation. The
picker reads these and labels rows in both directions (`→ bridged to Codex`,
`↳ continued from Claude Code`); re-bridging a conversation that already
embeds imported history is allowed but flagged. The default listing shows
both branch endpoints — abandonment is not assumed. The same edge is what lets
a downstream consumer (intent-recall) de-duplicate the copied prefix: target
turns `0..imported_through_seq` are known copies of the source, not fresh
evidence, so turnbridge does not need to alter capture to avoid double-count.

## Fabrication contract (per target adapter)

- Pin the CLI versions the writer was validated against; on an unknown version
  warn and offer bootstrap.
- Write only new session files under the CLI's own session directory; never
  modify existing native sessions.
- Represent foreign tool calls faithfully (or as clearly-labeled text when the
  target rejects unknown tool schemas — see per-adapter spec notes).
- Propagate the source model id into fabricated assistant envelopes verbatim
  (decided 2026-07-21). If the target harness recognizes it — e.g. the user
  registered matching external models in Claude Code — the session restores
  seamlessly; otherwise the target warns once and falls back to its default,
  which is accurate ("this bridge changed models"). Never substitute a
  recognized-but-false id.

Reverse-engineered, empirically verified format specs (pinned versions,
minimal working schemas, unknowns): [docs/specs/claude-session-format.md](specs/claude-session-format.md)
and [docs/specs/codex-rollout-format.md](specs/codex-rollout-format.md).
Key constraints: Claude resume is scoped to the project dir encoded from the
launch cwd and reconstructs history by walking `parentUuid` from the last
line; Codex resume-by-id scans `~/.codex/sessions` for a matching filename +
`session_meta` id, and only plain `message` response_items are verified-safe
to replay (foreign tool calls fold into labeled text). Claude accepts foreign
`tool_use` names verbatim, so Codex→Claude keeps structured tool history.

## Sharing model

`actor.id`/`actor.display` come from `git config user.email/name` at capture
time. Default listings: own + unattributed conversations; `--all` shows every
author with labels. Transport is optional-but-default-on: Conversation
Ledger's auto-installed pre-push hook and fetch refspec ride normal
`git push`/`git fetch`, gated by the ledger's secret scan and disableable per
user (`{"transport": {"hook": false, "fetchRefspec": false}}`); `cledger sync`
remains available for an explicit push/fetch/merge. Turnbridge adds no
network behavior of its own — it only reads whatever the ledger has already
absorbed locally. Events captured before identity stamping existed are
unattributed; a forced transcript rescan after the upgrade can duplicate
those turns under new event ids.

## Risks

Native formats change without notice (fabrication is version-pinned, bootstrap
is the recovery path); transcript content can include secrets (the ledger
redacts at capture and sync time, but matching is pattern/entropy-based and
cannot catch every secret — review before sharing still matters); full
histories can exceed the target's context (size is reported before launch);
crashes mid-turn leave partial capture, which the ledger tolerates by design.

## Roadmap

Toward an npm release (decided 2026-07-21; deepen the two existing targets
before broadening):

- Publish `conversation-ledger` to npm (name is unclaimed), then swap the
  `file:` dependency for a semver range — `prepublishOnly` refuses to publish
  until this happens. Deliberately deferred while both packages are iterated
  on and dogfooded for a few days.
- Adapter-drift automation stays **reporting-only** (decided 2026-08-02). The
  daily check (`.github/workflows/adapter-drift.yml`) opens a tracking issue on
  drift and now closes it when drift clears; it never writes to the repo.
  Auto-drafting the revalidation PR was built and then reverted. The reasoning
  is worth keeping, because the idea is tempting enough to recur: CI cannot
  validate a pin — the probes need both target CLIs installed, a TTY for the
  interactive smoke test, and paid model credentials per provider to make the
  recall turns real. So any PR CI opened would be a mechanical one-line bump
  with nothing behind it, saving a trivial edit while creating a *mergeable*
  artifact that asserts a validation nobody performed. An issue cannot be
  merged, and that asymmetry is the point. The agent-drafted variant (the old
  stage 2, needing an `ANTHROPIC_API_KEY` secret) fails for the same reason —
  the API key was never the binding constraint; the provider credentials the
  probes need are, and no amount of agency in CI conjures them.
- Revalidation tooling exists and is the bar for widening version pins:
  `npm run smoke:interactive` (real-TUI render check, both targets),
  `scripts/probe-codex-content.mjs` (headless model-recall probe),
  `probe-session-invariants.mjs` (malformed-session tolerance),
  `probe-large-history.mjs` (long histories, `PROBE_TURNS=N`),
  `probe-codex-function-call.mjs` (structured tool replay), and
  `probe-picker.mjs` (pty-driven picker behavior).
- **Spec verification gaps** *(closed 2026-07-27, claude 2.1.220 /
  codex-cli 0.145.0)*. Every unknown the two spec docs listed has been
  probed and each is now marked RESOLVED in place with its date and CLI
  version. (Minor pre-existing notes elsewhere in those docs — the `version`
  string's cosmetic role, sidechain turns — were out of scope and are
  untouched.) Findings that changed behavior:
  - **Duplicate `uuid` silently drops a turn** — resume still exits 0 with no
    warning. The one genuinely load-bearing invariant of the four; the other
    three (out-of-order timestamps, `sessionId`/filename mismatch, dangling
    `parentUuid`) are all tolerated. `src/test/fabricate-invariants.test.ts`
    guards it.
  - **Structured tool replay into Codex** — a `function_call` whose `name` is
    a tool Codex never registered is accepted, so Claude→Codex no longer
    flattens tool history to prose. Unpaired results stay prose, because an
    orphaned output carries no tool name at all.
  - **Bridged sessions are titled by their conversation**, not by the import
    notice: the picker reads `ai-title`, which fabricated sessions lacked.
  - Timestamps are normalized to millisecond UTC on write rather than trusting
    tolerance nobody measured; the fake `estimateTokens` heuristic is gone in
    favor of characters/bytes, now reported on the fabrication path too.
  Deliberately left unmeasured: histories beyond ~300 turns (both targets are
  clean to there, and fitting more is the target CLI's own job),
  `custom_tool_call` fabrication, and which key the Claude picker sorts on.
- **Encrypted-reasoning replay** *(shipped in 0.2.0)*
  — Codex's `reasoning` items are ciphertext only OpenAI's servers can
  decrypt; conversation-ledger 0.10.0 preserves them losslessly and opaquely
  (`kind: "reasoning"`, ciphertext in `raw.data`, `content` a bare opacity
  marker). `listConversations` (`src/conversations.ts`) now fetches
  `reasoning` events alongside `conversation_turn`s — `readEvents`'s `kind`
  filter is exact-match only, so it fetches unfiltered and narrows
  client-side — and carries them through `ConversationSummary.events` in
  seq order; `turnCount` still counts only visible turns.
  `src/targets/codex.ts`'s `buildRolloutLines` replays each reasoning
  event's verbatim `raw.data` response_item line at its correct seq position
  when `event.producer.source === "codex"` — gated per-event, not
  per-conversation, even though today's data model (a `ConversationSummary`
  groups by one native session id, hence one source) makes that equivalent
  to a per-conversation check in practice; genuine multi-hop carry-over
  (reconstructing an ancestor hop's reasoning via the lineage chain when
  re-bridging) is deliberately not built and stays a follow-up. Never
  applies to a Claude Code target: foreign reasoning can't be forged as a
  native reasoning item, so the only real switch is whether provider-matched
  replay happens, not what it's coerced into — unreadable/foreign reasoning
  is still folded into labeled text as before. On by default (decided
  2026-07-23); opt out with `--no-reasoning-replay` or
  `{"reasoningReplay": false}` in `~/.turnbridge/config.json` (`src/config.ts`).
  No ownership gate — replay applies to any synced conversation, not just
  the current user's own, per 2026-07-23 decision. The fabricated session's
  import notice (`buildRolloutLines`) is conditional: it discloses the
  replayed-block count when replay happened instead of the blanket "hidden
  reasoning ... not transferred" claim, and still states that claim for
  everything else in the same session. Empirically verified via
  scripts/probe-encrypted-reasoning.mjs (manual injection, independent of
  this integration): same-account and cross-account replay of a real blob in
  a fabricated session is accepted across sessions, CLI versions, and a
  different paid ChatGPT account (identical token accounting), so the
  ciphertext is not keyed per-account; the free tier cannot run Codex at all.
  Still open: blob TTL, and whether API-platform-org auth behaves the same
  as ChatGPT auth — turnbridge attempts replay unconditionally either way
  since auth mode isn't observable from here; a rejected blob at actual
  `codex resume` time has no proactive detection and falls under the same
  `--bootstrap` escape hatch as any other fabrication-drift failure.
