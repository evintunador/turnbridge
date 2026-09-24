# Hardening the portability policy split

**Status:** design note, 2026-08-11. Working through whether the three-tier
fabrication contract in [WIP_TECHNICAL_DESIGN.md](WIP_TECHNICAL_DESIGN.md#fabrication-contract-per-target-adapter)
is the right model, what it must cover, and where it should live in code.
Nothing here is decided yet.

## 0. Where the note came from

The tier list was written on 2026-08-06, immediately after
`providerID: "turnbridge"` bricked continuation on every bridged opencode
session. It is a post-mortem generalization: one field was assumed portable,
wasn't, and the fix needed somewhere to live. That origin matters, because a
model derived from a single incident tends to encode that incident's shape
rather than the general problem.

## 1. Is it a three-way split or a two-way one?

Three-way — but the axis currently stated is the wrong one, which is why it
reads like it might be two.

As written, tiers 2 and 3 are distinguished by *degree of overridability*:
tier 2 is "portable by default, overridden where required," tier 3 is
"target-specific, adapter owns it outright." On that axis the split really is
binary, because both tiers end with the adapter deciding the value. "Has an
overrideable default" vs. "has no default" is the natural next question, and
it is also not quite true: tier-3 fields mostly *do* have defaults. opencode's
`providerID` defaults to the first resolvable model; Claude's `parentUuid` has
a deterministic construction rule; Codex's `event_msg` twin is mechanically
derived from its `response_item`. They are not undefaulted. They are
*unsourced*.

The axis that actually produces three tiers is **where the value comes from**:

| Tier | Provenance of the value | Can a source fact be lost? | Owes disclosure? |
|---|---|---|---|
| 1 | The source, verbatim | No | No |
| 2 | The source *if the target accepts it*, else adapter-computed | Yes | **Yes** |
| 3 | The adapter, always — no source value exists | No | No |

Restated as a single sentence each:

1. **Carried** — the source value transfers unchanged.
2. **Negotiated** — the source value is attempted, and degraded to something
   the target can use when it fails.
3. **Constructed** — the target requires a value the source never had.

The load-bearing consequence is in the last column. **Tier 2 is the only tier
that owes the user a disclosure**, because it is the only tier where a fact
that existed in the source is not what ends up in the target. Tier 1 loses
nothing. Tier 3 loses nothing either — `parentUuid` is not a degraded version
of anything; it is scaffolding the source never had. Framing tier 3 as
"target-specific" makes it sound like the *most* lossy tier when it is
actually as lossless as tier 1.

That test — *did a source fact change?* — is sharper than "did the adapter
decide?", and it is the one that should govern, because disclosure is the
project's entire honesty mechanism.

## 2. The tier is not a property of a field

The current doc writes tiers as global properties: the model id "is" tier 2,
`parentUuid` "is" tier 3. The code says otherwise. Today, the same canonical
field — the source model id on an agent turn — is handled three different ways:

| Target | Treatment | Effective tier | Disclosed? |
|---|---|---|---|
| Claude Code | propagated verbatim into `message.model` (`claude-code.ts:195`, `:209`) | 1 | n/a |
| opencode | resolved against `opencode models`, substituted when unresolvable (`opencode.ts:200`) | 2 | yes (`opencode.ts:429`) |
| Codex | never written; `model_provider: "openai"` is hardcoded (`codex.ts:214`) | 2 in effect | **no** |

None of these three is a mistake in isolation, and the reason is instructive.
Claude's `model` is *cosmetic* — `docs/specs/claude-session-format.md:243` and
§2 establish it is telemetry, not read back for behavior, so verbatim
propagation is both safe and maximally faithful. opencode's `providerID` is
*dispatch* — the agent loop resolves its model from it, so an unresolvable
value is fatal. Codex takes its model from its own config or `-m`, never from
the rollout, so there is no field to carry it in at all.

So the discriminator underneath tier 2 is: **does the target read this field
back to decide behavior, or merely record it?** A field the target only
records can stay tier 1 indefinitely. A field the target dispatches from is
tier 2 the moment the source value might not resolve there. This is exactly
the distinction the opencode incident taught, but the note generalized it to
"the model id is tier 2" when the real lesson was "a dispatch field is tier 2."

**Proposal: tiers attach to `(field × target)`, not to fields.** Possibly to
`(field × source × target)` — the encrypted-reasoning case is tier 1 for
Codex→Codex and a disclosed drop everywhere else, which no per-field or even
per-target label can express. The tier table becomes a matrix, and it becomes
version-pinned data like the format specs, since a target upgrade can move a
cell.

### The undisclosed-drop gap

Codex is the live instance. A Claude→Codex bridge silently discards which
model produced every historical turn, and the import notice does not mention
it. Under the contract's own rule that is a tier-2 field with no disclosure.
It is a small loss — arguably the smallest one available — but it is precisely
the class of quiet degradation the tier model exists to prevent, and it went
unnoticed because the rule lives in prose that adapters are trusted to follow.

That suggests a fourth bucket the note should name explicitly rather than
leave implicit:

0. **Dropped** — a source fact with no target representation at all
   (thinking signatures, foreign reasoning ciphertext, actor identity).

Dropped is not a separate tier so much as tier 2's terminal case: the
substitute is nothing. The rule to harden is that **a drop is still a
disclosure**, and silent drops are forbidden. Today thinking blocks are folded
to labeled text (disclosed, correct); reasoning ciphertext is disclosed
(correct); the model id on the Codex path and the human author's git identity
on every path are dropped silently (not correct).

## 3. Which data entries the split has to cover

Working from the canonical model (`TurnBlock` types, `ConversationSummary`,
ledger event kinds) rather than from any one target's schema:

**Content — mostly tier 1, this is the part that must not erode**

- turn role (human / agent / tool_result)
- visible text
- turn ordering
- occurrence timestamps

Ordering and timestamps deserve a footnote: they are tier 1 in *meaning* but
their realization is tier 3. opencode renders parts in `id` order and sorts
messages by `time.created`, so preserving the portable invariant "these turns
are in this order" required target-specific id minting and a backdated import
notice. **A tier-1 invariant can require tier-3 machinery to hold.** The tier
of the guarantee and the tier of the mechanism are different things, and the
note currently conflates them by saying tier 1 means "shared code writes these
once; adapters do not touch them."

**Content — tier 2, the negotiated set**

- thinking / plaintext reasoning → labeled text
- opaque reasoning ciphertext → verbatim (Codex→Codex) or dropped + disclosed
- tool call name and input → structured where accepted, prose where not
- tool result content and its pairing id → prose when orphaned
- source model id → per the matrix above

**Envelope — tier 3, adapter-private, no shared abstraction warranted**

- session and message ids (and their ordering role in opencode)
- parent / lineage links (`parentUuid`)
- provider and project scoping (`providerID`, `projectID`, `cwd` encoding)
- session scaffolding (`step-start`/`step-finish`, `event_msg`/`response_item`
  twins, `session_meta`)

**Neither — derived and meta fields the current model has no slot for**

- **Picker title** (`ai-title`): computed from tier-1 content by a
  target-specific rule. Not carried, not constructed — *derived*. Duplicated
  verbatim today in `claude-code.ts:134` and `opencode.ts:348`.
- **The import notice itself**: turnbridge's own field, present in no source.
  It is the sink every tier-2 disclosure drains into, which makes it
  structurally special and worth naming as such.
- **Actor identity** (`actor.id`, the git email): a genuine ledger-side fact
  with real product weight — it is what the multi-user sharing model runs on —
  and it survives into no target session in any form. Currently an undisclosed
  drop across all three adapters. Whether it *should* transfer is an open
  product question, but it should be an answered one.

## 4. Unified code system, or per-data-type principle?

**Neither extreme. A thin shared spine, adapter-owned rendering, and a shared
conformance suite.**

Against full unification: the three targets' containers have almost nothing in
common — a JSONL `parentUuid` chain, paired rollout lines in a session
directory, and a payload shelled into `opencode import` against a shared
SQLite DB. A generic tier-aware field-mapping engine over those three would be
mostly escape hatches, and the escape hatches are where all the actual
behavior lives. Building it would add a layer without removing a decision.

Against pure principle: prose discipline already failed once, visibly. The
Codex model-id drop is the proof — every adapter is trusted to remember a rule
written in a design doc, and one of them didn't.

The seam is that **tier 1 and the *accounting* of tier 2 are unifiable; the
*realization* of tier 2 and all of tier 3 are not.** Concretely, three pieces:

1. **A shared portable-turn normalizer.** One function from `summary.events`
   to an ordered `PortableTurn[]` (`role`, `blocks`, normalized timestamp,
   source model id, reasoning passthrough). Each adapter re-derives this today
   — including the role-mapping rule that tool results ride on user turns,
   which is a portable fact currently written three times. This is what "shared
   code writes tier 1 once" would actually mean; right now that sentence in the
   design doc describes an aspiration, not the code. `pickerTitle` collapses in
   here too.

2. **A degradation ledger.** While converting, an adapter records each tier-2
   decision as structured data — `{ field, sourceValue, written, reason }` —
   instead of remembering to write a sentence. One shared function renders the
   import notice from those records. This converts "tier 2 owes a disclosure"
   from a discipline into a mechanism: the notice is *derived from* what the
   adapter actually did, so an undisclosed substitution stops being
   expressible. It also fixes the notice's three-way near-duplication
   (`claude-code.ts:174`, `codex.ts:192`, `opencode.ts:434`), which is how the
   three notices drifted into making different claims in the first place.

3. **Tier 3 stays entirely private.** No interface, no hooks, no registry. It
   is irreducible per-target knowledge and any abstraction over it is a lie
   that will cost a debugging session later.

Plus the part that makes tier 1 enforceable without unifying the writers:

4. **A cross-adapter conformance suite.** Each adapter already can produce a
   fabricated payload; each format spec already documents how to parse one
   back. A shared test asserting the tier-1 invariants — every visible turn
   present, in source order, roles preserved, no turn dropped — run identically
   against all three adapters, is how the portable set stays portable. It
   generalizes `fabricate-invariants.test.ts`, which guards exactly one such
   invariant (duplicate `uuid` drops a turn) for exactly one target.

So: unified normalizer (tier 1), unified disclosure accounting (tier 2's
bookkeeping), private realization (tier 2's mechanics and all of tier 3),
unified assertions (tier 1's enforcement).

## 5. Concerns, and where this cuts against the project's aims

**The tier model is a concession framework, and concessions ratchet one way.**
Turnbridge's differentiator over "summarize and paste" is literal replication.
The tier list names the sanctioned ways replication is allowed to fail — which
is necessary, but once a field is labeled tier 2 the cheap path is always
"substitute and disclose," because disclosure is free and always available.
The 2026-08-06 amendment ("honesty belongs in the disclosure, not in a
dispatch field") was right for the case that produced it and is a
general-purpose excuse in every other. Hardening should add a ratchet in the
other direction:

- A field moves 1→2 only on *demonstrated* target failure, recorded in the
  format spec with the CLI version that showed it — never on suspicion or
  convenience.
- Tier 2 adapters must *attempt* the portable value first. opencode's
  `resolveModel` does this correctly. It is the pattern, not the exception.
- The tier-2 count is a debt metric to drive down, not a stable architecture.
  A user registering matching external models in Claude Code moves the model
  id back to tier 1 for that install; the design should treat that as the
  goal rather than an edge case.

**Disclosure has a budget.** The import notice is a user turn injected at the
top of the target model's context. Every substitution that appends a sentence
spends context on turnbridge meta-text before the conversation the user came
for. Three or four disclosures in and the notice is competing with the
history it introduces. The degradation ledger should be able to summarize —
"4 fields adapted for Codex; details in the turnbridge log" — rather than
concatenate indefinitely. Worth deciding what the notice is *for*: is it a
legal-style completeness record, or the minimum the model and user need? Those
give different designs, and right now it is drifting toward the first while
being read by the second.

**Tiers are version-pinned data, not design.** A field is tier 1 until a
target release makes it tier 2. That puts the tier matrix in the same category
as the format specs and the validated-version pins, and it raises a question
for the drift automation: the daily check watches CLI versions, but the thing
that actually breaks is a tier assumption. Whether a probe can test *tier*
assumptions (does the target still tolerate a foreign tool name? does it still
ignore the `model` field?) rather than just versions is worth asking, though it
runs into the same credentials-in-CI wall documented in the roadmap.

**Open question — does tier apply to capture, or only to fabrication?** This
is a write-side contract today. But the ledger has the same problem mirrored:
opencode `reasoning` parts arrive as plaintext and become ordinary visible
thinking, which is a tier-2 degradation performed on the *read* side, by
cledger, outside this contract's scope. If the vocabulary only covers
fabrication, round-trip discussions will keep sliding between two meanings of
"portable." Deciding that tier is a property of the whole bridge — source
capture through target fabrication — is more honest, but it puts part of the
contract in another package's hands.

*Followed up in [LINEAGE_AND_COMPOUNDING.md](LINEAGE_AND_COMPOUNDING.md),
which traces this to a compounding-degradation bug across multi-hop bridges
and lands on a narrower answer than "it becomes cledger's contract."*

## 6. What I'd change in the note itself

- Restate the axis as provenance (carried / negotiated / constructed), and
  make the disclosure obligation the defining consequence of tier 2.
- Say tiers attach to `(field × target)` — at least — and add the matrix.
- Drop or qualify "Shared code writes these once; adapters do not touch them,"
  which is not true of the code today; either make it true (§4.1) or state it
  as the target state.
- Separate the tier of a *guarantee* from the tier of its *mechanism*
  (ordering is the example).
- Name the dropped bucket, and state that a drop is a disclosure.
- Add the ratchet rules from §5.
