# Multi-hop lineage and compounding degradation

**Status:** implemented, 2026-09-23; design note written 2026-08-13 and revised
2026-08-23. Companion to
[POLICY_SPLIT.md](POLICY_SPLIT.md), which asked whether the fabrication tier
model covers capture as well as write. This is that question followed all the
way down: it turns out to be a three-repo architecture question spanning
conversation-ledger, turnbridge, and context-graph.

Most of this is still undecided. The exception is §4's extension-ownership
question, which is settled in annals' README: annals owns storage, while the
producer owns its vocabulary, versioning, and reader.

## 1. What "actor identity" means

`Actor` in conversation-ledger (`src/schema.ts:89-95`) is
`{ type, id?, display? }` where `type` is `"human" | "agent" | "system"` and
`id` is documented as "git author email **or** model id". So the field is
polymorphic by actor type:

| Turn | `actor.type` | `actor.id` | What it identifies |
|---|---|---|---|
| a human prompt | `human` | git author email | **the person at the keyboard** |
| an agent reply | `agent` | model id | the LLM |
| a turnbridge continuation | `system` | `"turnbridge"` | the tool |

The **coding CLI is none of these** — it is `producer.source`
(`"claude-code"`, `"codex"`, `"opencode"`).

So when POLICY_SPLIT §3 lists actor identity as an undisclosed drop, it means
**the human's git email**, on human turns. Solo, that is harmless: bridging
your own conversation into your own CLI loses a fact you already know. It
matters for the second user PRODUCT_INTENT names — "small collaborating
groups whose members use *different* CLIs and want to pick up each other's
conversations." Bridge Alice's conversation into Bob's Codex and every human
turn renders unattributed, so neither Bob nor the model reading the history
can tell that two people were involved, or which one asked for what. That is a
real fidelity loss in exactly the scenario the product exists to serve.

### Where the drop happens

There is no line of code that discards it. **No adapter ever writes it**,
because none of the three target session formats has a per-turn human-author
field — they are single-human formats by construction. All three build user
turns from role and content alone: `{ role: "user", content }`
(`claude-code.ts:218`), `messageLine(ts, "user", text)` (`codex.ts:75`),
`info: { role: "user", … }` (`opencode.ts:448`).

The sharp part is the asymmetry it creates. `transcript.ts:32` renders
`## User (${event.actor.display})` — so **the bootstrap path preserves human
attribution that the fabrication path loses.** Bootstrap is supposed to be the
strictly-less-faithful fallback; on this field it is strictly more faithful
than the primary path. That inversion is the actual defect, more than the
missing field itself.

The fix is ordinary tier-2 treatment: a portable value exists, the target has
no slot for it, so degrade to a visible label and disclose. Concretely, prefix
human turns with the author's display name when a conversation has more than
one distinct human author (or when the author is not the current user), and
say so in the import notice. Gated that way it stays invisible for solo
bridges, which are the common case. The data is already computed and unused —
`conversations.ts:62-68` builds `owners` and `ownerDisplays` for every
conversation, and no adapter reads either.

### A related, more concrete gap

While confirming the above: cledger has shipped **`producer.model`,
`producer.provider`, and `producer.source_version` since 0.12.0**
(`src/schema.ts:110-126`), explicitly for per-turn agent provenance, recorded
only when the source states it and never inferred. **Turnbridge reads none of
them.** Every model-id decision in the codebase reads `actor.id`
(`claude-code.ts:195`, `opencode.ts:193`), which is the older, polymorphic,
convention-based field.

Two consequences, both cheap to fix and both entirely inside turnbridge:

- `producer.model` is the field that actually means "the model that served
  this turn." `actor.id` means that only by convention, and only on agent
  turns.
- `opencode.ts:217-221` currently *guesses* a provider by string-splitting the
  model id ("either a fully-qualified `provider/model`, or a bare model id").
  `producer.provider` is the real answer when the source stated it — and
  cledger deliberately leaves it unset rather than inferring, so an unset
  value is meaningful rather than missing.

This does not change the tier of the model id, but it means the tier-2
negotiation currently runs on worse input than the ledger already offers.

## 2. The multi-hop problem is real, but not for the stated reason

The intuition — `claude → codex → opencode → claude` loses information and
"doesn't know enough to resume the original" — is right about the outcome and
wrong about the cause. It is worth separating, because the two have different
fixes and only one of them is hard.

### Lineage is *stored*, transitively, today

`recordContinuation` (`src/lineage.ts:30`) writes a real ledger event per
bridge, and `readLineage` builds `parentOf: Map<target, record>` — a
**single-parent map**. Walking it transitively reconstructs the entire chain
back to the original Claude conversation. The data is complete and it syncs
with the conversations it links.

Nothing walks it. Every consumer is one-hop:
`lineageTag` does `parentOf.get(summary.id)` and `childrenOf.get(summary.id)`
for picker labels (`resume.ts:38-40`), and `resume.ts:117` checks
`parentOf.has()` to flag a re-bridge. There is no transitive walk anywhere in
the codebase.

So the knowledge exists and is unused. That half is a consumption gap, not a
data gap — which is good news, because it means no schema work is needed to
close it.

### The actual loss: the lossy render is re-captured as source truth

Here is the mechanism, and it is worse than forgetting the ancestor:

1. turnbridge fabricates `claude → codex`. Per the tier model, that render
   degrades: thinking folds to `[visible thinking]` text, unpaired tool
   results fold to prose, the model id is dropped, and a
   `[turnbridge import notice]` user turn is prepended.
2. The user continues in Codex. cledger captures that Codex session as a new
   conversation — **faithfully**, because cledger's job is to record what the
   source contains, and it has no way to know turnbridge authored it.
3. turnbridge's degraded output is now canonical evidence, indistinguishable
   from anything a human and model actually produced.
4. Bridging onward `codex → opencode` reads that conversation and degrades it
   *again* — folding already-folded text, prepending a second import notice.

Degradation compounds because **the output of the pipeline is re-ingested as
its input**. Four hops in, a thinking block reads
`[visible thinking]\n[visible thinking]\n[visible thinking]\n…` and the
transcript opens with a stack of nested import notices, each announcing a
different source CLI. The design doc already anticipates the symptom —
"re-bridging a conversation that already embeds imported history is allowed
but flagged" — but flagging is not handling.

### This exact bug class has already bitten this ecosystem once

cledger's design doc (`WIP_TECHNICAL_DESIGN.md`, secret-scan reports, 0.16.0)
records this, and records it as **observed while dogfooding turnbridge**:

> the *context* around a match is what tripped the rule in the first place …
> so a report captured into a later conversation re-seeded a finding on the
> report itself, and each scan compounded the last … one discussion of GitHub
> Actions code multiplied into repeat findings that `cledger allow` could not
> durably clear.

Same disease: a tool's output landed back in the record as input, and each
cycle amplified it. The fix chosen there is the fix that generalizes —
**"Reports carry coordinates, never content."** Reference the original instead
of reproducing it, and the loop cannot compound.

## 3. Why turnbridge cannot simply adopt that fix — and what it can do instead

context-graph's design already states the referencing principle for this exact
edge (`WIP_TECHNICAL_DESIGN.md`, `continuation` edge kind): "the copied prefix
is reachable through the pointer, not re-materialized." That is correct for
context-graph and impossible for turnbridge, and the asymmetry is the crux:

**context-graph may reference; turnbridge must copy.** Fabrication *is*
re-materialization — a native session file the target CLI reads directly. The
target cannot follow a pointer into git notes. So the copy will always exist,
and cledger will always capture it. "Don't re-materialize" is not available.

What *is* available is a one-word change to the rule:

> **Copy from the original, never from the previous copy.**

Concretely: when bridging conversation `C`, walk `parentOf` transitively to
the root. For any turn in `C` that the lineage record marks as an imported
copy — `imported_through_seq` says exactly which prefix that is — render from
the **ancestor's original event**, not from `C`'s re-captured degraded
version. Only turns `C` genuinely originated get rendered from `C`.

This is entirely a turnbridge-side change, needs no schema work, and fixes
four things at once:

- No compounding. Each hop degrades the *original* once, never a degradation.
- One import notice, naming the true origin, instead of a nested stack.
- **Multi-hop reasoning replay**, which the design doc currently defers:
  "genuine multi-hop carry-over (reconstructing an ancestor hop's reasoning
  via the lineage chain when re-bridging) is deliberately not built and stays
  a follow-up." `codex → claude → codex` can restore the original encrypted
  blobs, because it reads the Codex-origin events rather than the Claude
  session's prose fold of them. Same mechanism, already-identified follow-up.
- Model id, tool structure, and human attribution survive arbitrarily many
  hops, since each is re-read from where it was stated.

One refinement worth building in the same pass: `imported_through_seq` is seq
arithmetic, which is cheap but coarse — it identifies a *range*, and assumes
positional correspondence survived the render. turnbridge knows more than that
at fabricate time: it knows the exact ordered list of source event ids it
rendered. Recording that list in the `continuation` event's content makes the
mapping precise (target position *i* ⟵ source event `ev2-…`) at essentially no
cost, and needs no cledger change — `content` is uninterpreted by design.

## 3a. What the walk should actually do

"Walk `parentOf`" is the easy half. The hard half is what to render once you
have the chain, and the three candidate policies — *use the most recent
cross-CLI hop's data*, *go back as far as possible*, *restore only what suits
the CLI resuming now* — feel equally arbitrary because they mix **two
different axes**. Separated, one of them stops being a choice at all:

- **Which target do you render *to*?** Not a decision. Always the CLI being
  resumed into, under the current tier matrix. The third candidate is
  therefore not an alternative to the other two; it is what fabrication
  already does, and it applies on top of whatever the other axis decides.
- **Which evidence do you render *from*?** The real question.

On the second axis, neither "most recent" nor "as far back as possible" is
right, because **the chain is not homogeneous**. In
`claude → codex → opencode → claude`, turns 0–20 originated in Claude, 21–35
in Codex, 36–50 in opencode. Every turn has exactly one origin. "Most recent"
flattens all of them to the worst common denominator; "as far back as
possible" is undefined for turns that did not exist that far back.

So the rule is per-turn, not per-conversation:

> **Render each turn from the conversation where that turn originated.**

`imported_through_seq` on each continuation record gives the segment
boundaries directly, and single-parent `parentOf` makes the walk unambiguous.
This is a third policy, and the only one that is not arbitrary — it is the
unique choice that never renders from a copy when an original exists.

### The remaining decisions, which are real

**(i) As-recorded, or as-it-would-have-been?** This was the genuine fork. The
human at hop 3 *actually saw* `[visible thinking]`-folded text, and may have
replied to it ("your reasoning above about X is wrong"). Re-sourcing the
Claude original puts content in front of the model that was not in the session
the human experienced. Reconstructing "the conversation as recorded" and
"the conversation as it would have been without transport damage" are
different artifacts, and *most faithful* is ambiguous between them.

Decision: **as-it-would-have-been.** PRODUCT_INTENT says turnbridge moves the
literal record of the work; the fold markers are transport artifacts turnbridge
itself introduced, never content anyone authored. Restoring them is undoing our
own damage, not inventing history. But it should be a stated decision, because
the other reading is defensible and the difference is invisible once shipped.

**(ii) Ancestor availability.** The ancestor conversation may not be present:
transport may not have synced a collaborator's, or it may be unreachable from
`HEAD` under the default filter. Re-sourcing must degrade gracefully to the
copy, and disclose that it did.

This is where cleanup of artifacts like `[visible thinking]\n[visible
thinking]\n…` belongs — and the useful consequence is that **unwrapping
heuristics become the fallback, not the mechanism.** That matters, because
regex-unwrapping is genuinely unsafe as a primary strategy: a human can type
`[visible thinking]` legitimately, and stripping it silently edits their
words. Confined to the path where the original is unavailable, and disclosed,
it is an acceptable last resort.

**(iii) Ancestral import notices.** Each hop's notice is a real captured user
turn — the human did see it. When re-rendering, drop the ancestors' notices
and emit one that names the whole chain. Safe, because the notice is the one
piece of content turnbridge can identify with certainty as its own; and
necessary, because a stale notice actively misinforms — it names the wrong
source CLI for the history that follows.

## 4. What actually belongs upstream in cledger

Separating what the fix needs from what the ecosystem needs:

**Not needed for the fix above.** Everything in §3 is turnbridge-side. Worth
saying plainly, because "this is a cledger design question" is the kind of
conclusion that defers a fix behind a dependency that isn't real.

**Genuinely a cledger question: conversation-level edges have no owner.**
cledger today has three relational notions and none of them is this one:

- `EventLink { rel, target }` — event→event, rels `redacts`, `supersedes`,
  `annotates`, `replies_to`.
- `ConversationRef.parent` — conversation→conversation, but specifically for
  *sub*-conversations (sidechains, subagent sessions).
- `re_anchor` events — commit→commit remapping.

A bridge is conversation→conversation but is **not** a sub-conversation: it is
a successor/fork, not a child. With no first-class slot for it, turnbridge
improvised — a custom `continuation` kind, attached to the target conversation
at `seq: 0`, with the real payload in uninterpreted `content`. That is a
sanctioned extension (`schema.ts:7-9` explicitly invites downstream tools to
add kinds without a schema release), so it was the right call at the time.

What changed is that context-graph now reads it — its `continuation` edge kind
parses turnbridge's `rel:"continues"` and its `imported_through_seq`. The
moment a second tool depends on that payload, a private convention has become
a **de-facto public interface with no owner and no versioning**. intent-recall
is likely the third.

An earlier draft of this note proposed fixing that by promoting `continues`
into cledger's own vocabulary. That is the wrong shape: it would make cledger
aware of turnbridge, inverting the dependency for no gain — cledger would be
documenting a relation it has no use for and cannot validate the meaning of.
The problem was never that cledger lacks the concept. It is that **consumers
are hardcoding a producer's payload shape**, and there are two ways to fix
that without cledger learning anything about bridging:

- **The producer publishes its reader.** turnbridge already exports
  `readLineage` and `ContinuationRecord` (`src/lineage.ts:6-23`). context-graph
  depends on turnbridge-the-library for that one edge kind rather than parsing
  `content` by hand. Whoever emits a vocabulary owns its reader — the same
  rule that already governs cledger's capture adapters.
- **cledger offers generic extension facilities**, which is the more
  interesting half. Today the extension point is "`kind` is an open string and
  `content` is uninterpreted" — real, but ungoverned.

Note that cledger already *has* the input half of this: `appendEvents` is a
public library entry point and turnbridge already uses it correctly. Its
history says how deliberate that is — `appendEvents` has been module-exported
since v0.1.0, but the package had no entry point at all until `c08f650`
("Add library entry point and human-turn identity stamping", 2026-07-19)
created one *for turnbridge*, and `src/index.ts` still describes itself as the
"Public library surface for programmatic clients (e.g. turnbridge)". It is a
retrofitted front door, not a designed external-input API — though the append
path behind it is sound, enforcing validation, capture-tier redaction,
id-dedup, and per-repo locking on everything a third party writes.

**This design is now settled in annals' README.** The short version, which
supersedes what this note previously proposed: a
third-party kind is identified by the pair **`(producer.tool, kind)`**, never
by `kind` alone. An earlier draft here proposed namespacing the kind string
(`turnbridge/continuation`); that was redundant string-packing, since cledger
already carries the producer as structured data on every event and
`producer.version` states which revision of the vocabulary an event was
written against. Annals deliberately has no registration or discovery
mechanism: whoever emits a vocabulary publishes its reader. For
`continuation`, that reader is turnbridge's `readLineage`; consumers import it
rather than parsing `content` themselves.

**Worth considering, with a real cost: event-level derivation.** A captured
turn that is a lossy copy of an earlier event has no way to say so. If it did
(`rel: "derived_from"`, or a fidelity marker), any consumer could resolve a
copy to its original without knowing turnbridge's seq conventions. It fits
cledger's grain — `supersession` (replaced by better) and `unrecognized` (raw
kept for a smarter version later) are the same instinct.

The cost is where it gets awkward: cledger captures the target CLI's session
file independently and cannot tell a fabricated session from a native one, so
it cannot stamp the derivation itself. Either turnbridge pre-registers the
mapping (which is §3's event-id list, already proposed and cheaper), or
capture learns to recognize turnbridge's output — which means cledger knowing
about turnbridge, inverting the dependency. **Recommendation: do the
event-id list in the `continuation` payload first.** It buys most of the
value; revisit event-level derivation only if a consumer needs it that
cledger cannot serve through the lineage edge.

## 5. On keeping the tools divided

The instinct that these were meant to be separate projects and keep drifting
together is worth taking seriously — but the evidence says the division is
sound and only the *seam* is drawn in the wrong place.

The current seam is **by phase**: cledger owns capture, turnbridge owns
resume. That breaks here for a structural reason: turnbridge's output becomes
cledger's input, so the pipeline is a **cycle, not a line**, and a phase-based
split has no way to say who owns a fact that arises from going around the
loop.

A seam that survives a cycle is **by ownership of the record**:

- **cledger** owns *facts about records*, including how records relate to each
  other. A conversation-level edge is a fact about records, not a fact about
  resuming.
- **turnbridge** owns *rendering a record into a target CLI*, and — like any
  adapter — produces facts that cledger stores. Writing a `continuation` event
  is turnbridge acting as a producer, which is exactly the role cledger's
  extension point anticipates.
- **context-graph** owns *derived structure* over those facts, and is
  explicitly forbidden from being a second store ("Nodes reference artifacts;
  content lives where it already lives").

That last point settles a layering question worth being explicit about:
**context-graph cannot be where lineage lives.** It commits to being a derived,
rebuildable view — same inputs, same graph. But "this conversation was
fabricated from that one" is *not derivable* from any artifact. Only
turnbridge knows it, only at the instant it bridges. It has to be **recorded**
by turnbridge into cledger, and then *read* by context-graph. Which is
precisely what happens today.

So the architecture is already right. The three problems are narrower than the
architecture:

1. turnbridge doesn't consume its own lineage transitively (§2, one-hop only).
2. turnbridge copies from the copy rather than the original (§3).
3. `continuation` is a private convention that two other tools now depend on
   (§4).

None of those requires collapsing the tools together. (2) is the one that
loses data today.
