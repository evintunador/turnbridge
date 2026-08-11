# opencode native session / import format — reverse-engineering spec

Purpose: enable `turnbridge` to FABRICATE an opencode session that `opencode -s <id>` will
resume with the fabricated prior conversation visible to the model and rendered in the TUI.

Pinned environment:
- `opencode --version` → **1.18.5**. npm package: `opencode-ai`.
- Tested on macOS (darwin), zsh, default data dir `~/.local/share/opencode/`.

Everything below was verified empirically against this exact build on 2026-08-02, by
fabricating payloads, importing them, listing/resuming the result, and rendering the resumed
session in a real pty (`scripts/pty-run.exp`). Where a claim is *not* verified it says so.

---

## 1. Storage: one SQLite DB, not per-session files

Unlike Claude Code (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`) and Codex
(`~/.codex/sessions/<date>/rollout-*.jsonl`), opencode keeps **all** sessions in one SQLite
database: `~/.local/share/opencode/opencode.db`. Relevant tables: `session`, `session_message`,
`message`, `part`, `project`, `project_directory`.

Consequence for fabrication: there is no "write a new file into a directory the CLI scans"
path. The two options are writing SQLite directly (schema-coupled, racy against a running
opencode) or going through opencode's own ingestion command. **turnbridge uses the latter.**

## 2. Commands

| Command | Behavior |
|---|---|
| `opencode -s <sessionID>` | Resume a session by id (TUI). Also `--session`. |
| `opencode -c` / `--continue` | Continue the *last* session. |
| `opencode export [sessionID]` | Dump a session as JSON to stdout. `--sanitize` redacts. |
| `opencode import <file>` | Load a session from a JSON file or share URL. |
| `opencode session list` | List sessions **for the current directory's project**. |
| `opencode session delete <sessionID>` | Delete a session. |
| `opencode debug scrap` | JSON list of all known projects (`id`, `worktree`, …). |

`export` and `import` use the same envelope, so **a real exported session is the ground truth
for what a fabricated one must look like**.

Verified properties of `import`:
- On success it prints exactly `Imported session: <sessionID>` on stdout, exit 0.
- It honors `info.id` from the payload — the imported id is the one supplied, not a new one.
- It is **idempotent by id**: re-importing the same payload updates in place, no duplicate row.
- It is **not atomic**. A payload rejected part-way (see §5) leaves the messages accepted so far
  in the DB as a truncated session, visible in `session list`. Callers must clean up.
- Validation errors are reported as a path into the payload, e.g.
  `Error: Unexpected error / Missing key at ["state"]["title"]`, with no indication of which
  message or part was at fault.

There is **no argument-free "open the session picker" invocation** — `-s` always takes an id,
`-c` names a specific session, bare `opencode` starts a new one. This is why turnbridge installs
no opencode shim (see `src/shim.ts`).

## 3. Envelope

```jsonc
{
  "info": { /* session */ },
  "messages": [ { "info": { /* message */ }, "parts": [ /* parts */ ] } ]
}
```

### 3.1 `info` (session)

Observed on a real export:

```jsonc
{
  "id": "ses_042f83972ffeNdS75n197unLAD",
  "slug": "tidy-moon",
  "projectID": "5687eeea165450405ca0226fde0ab28e91701579",
  "directory": "/Users/me/repos/turnbridge",
  "path": "",
  "title": "Turnbridge opencode support check",
  "agent": "build",
  "model": { "id": "deepseek-v4-flash", "providerID": "ds4" },
  "version": "1.18.5",
  "summary": { "additions": 0, "deletions": 0, "files": 0 },
  "cost": 0,
  "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } },
  "time": { "created": 1785582831245, "updated": 1785594863222 }
}
```

- `id` — arbitrary string, not a UUID. Native ids are `ses_<base62>`; turnbridge writes
  `ses_tb_<uuid>` so bridged sessions are identifiable on sight. Accepted without complaint.
- **`projectID` is load-bearing and is honored verbatim.** It scopes which directory lists the
  session. Ids are opaque hashes stored in the `project` table — *not* a plain sha1 of the
  worktree path (checked: sha1 of the path, path+newline, and lowercased path all mismatch), so
  they must be **looked up**, via `opencode debug scrap`, matching `worktree` against the launch
  cwd. `"global"` is a real fallback project (worktree `/`); a session filed there is listed
  from **every** directory, which is why turnbridge only uses it when the cwd maps to no
  registered project.
- `title` — what `session list` and the TUI picker display. Fabricated sessions title themselves
  by the first human message, not by the import notice (same reasoning as the other targets).
- `time.updated` is the picker's sort key; turnbridge stamps it `now` so a freshly bridged
  session sorts to the top even though its *messages* are backdated (§4).
- `permission` was written by an earlier draft of the adapter and is **not** present on real
  exports; it imports fine but is not part of the format.

### 3.2 `info` (message)

User:
```jsonc
{ "role": "user", "time": { "created": 1785582831260 }, "agent": "build",
  "model": { "providerID": "ds4", "modelID": "deepseek-v4-flash" },
  "summary": { "diffs": [] }, "id": "msg_…", "sessionID": "ses_…" }
```

Assistant:
```jsonc
{ "role": "assistant", "parentID": "msg_…", "mode": "build", "agent": "build",
  "path": { "cwd": "…", "root": "…" }, "cost": 0,
  "tokens": { "total": 7918, "input": 7601, "output": 317, "reasoning": 0,
              "cache": { "write": 0, "read": 0 } },
  "modelID": "deepseek-v4-flash", "providerID": "ds4",
  "time": { "created": …, "completed": … }, "finish": "tool-calls",
  "id": "msg_…", "sessionID": "ses_…" }
```

**`parentID` semantics** (measured on a real 98-message export): user messages carry **no**
`parentID`; each assistant message points at **the user message that prompted it**, so several
consecutive assistant messages share one parent. It is a prompt→replies tree, not a linked
list. Chaining every message to its predecessor (an earlier draft) parents user messages to
assistant messages, which no native session does.

## 4. Message ordering is by `time.created`, not payload order

The rendered order comes from the timestamps, not the array. Practical consequence, observed:
an import notice stamped at fabrication time is *newer* than every backdated history message, so
it renders **last**, and a trailing user message with no assistant reply renders with a
**`QUEUED`** badge — i.e. it reads as a prompt about to be sent rather than a preamble.

This is the opposite of the Claude Code target, where the notice is deliberately stamped `now`
because that format renders in file order. turnbridge therefore backdates the opencode notice to
`earliest_event_ms - 1`. Verified: notice renders first, no `QUEUED` badge.

### 4.1 Ids are an ordering key too *(added 2026-08-06, 1.18.5)*

`time.created` governs **rendered message order**, but ids carry ordering of their own, and both
bit us:

- **Parts within a message are ordered by `id`, not by array position.** Measured: a fabricated
  assistant message's exported part order was exactly its id-sorted order, while native part ids
  ascend with emission (`prt_fd479a2f1001…` step-start < `prt_fd479a6c4001…` text <
  `prt_fd479a716001…` step-finish). This was invisible while turnbridge emitted exactly one part
  per message; adding step-start/step-finish surfaced it immediately, with `step-finish` exported
  ahead of `step-start`. Part ids must therefore be minted in the order the parts should appear —
  including allocating the `step-start` id *before* converting the message's content parts.
- **Message ids must also sort ahead of ids opencode mints later.** Native ids are time-ascending
  base62 (`msg_fd4799cd2001…` < `msg_fd4b3c98d001…`), presently in the `f` range. turnbridge's
  old `msg_tb_<uuid>` lost twice: `t` sorts after `f`, so every fabricated message ranked *after*
  the reply opencode was about to write, and the uuid randomized history against itself.
  Observed effect: a resumed fabricated session answered and then **kept generating** — 10-13
  assistant turns for a single prompt, until the process was killed — where a native session in
  the same directory, project, and model answered once in 12.6s. Giving fabricated ids a leading
  `0` and an emission counter reduced that to exactly one assistant turn, with the same prompt and
  model. The rendered transcript looked correct throughout, which is why this hid behind the
  provider bug in §6.

turnbridge now writes `msg_0tb<counter><rand>` and `prt_tb_<stamp><counter><rand>`.

## 5. Parts

Observed types: `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `patch`.

Every part carries `id` (`prt_…`), `sessionID`, `messageID`.

- **`text`** — `{ type, text, id, sessionID, messageID }`. Minimal and always accepted.
- **`reasoning`** — as `text` plus `time: { start, end }`. Renders as a collapsed
  `+ Thought: <duration>` line.
- **`step-start`** / **`step-finish`** — real assistant messages are wrapped in the pair, both
  carrying a `snapshot` git sha; `step-finish` also carries `reason`, `tokens`, `cost`.
  *Revised 2026-08-06:* the earlier note here said `step-start` was "not required", because a bare
  `text` part renders fine — which is true of **rendering** and was the wrong test. The TUI and
  the agent loop are built around these parts, so turnbridge now emits both, with the launch
  repo's `HEAD` as `snapshot` (omitted outside a git repo) rather than inventing a sha. Mind §4.1:
  the `step-start` id has to be allocated before the content parts or it sorts after them.
- **`tool`** — `{ type: "tool", tool: <name>, callID, state, … }`. **`state` requires all six of
  `status`, `input`, `output`, `title`, `metadata`, `time`.** Omitting any one fails the entire
  import with `Missing key at ["state"][<name>]` — bisected key by key. This is the single
  constraint most likely to be missed, since a tool-free conversation imports cleanly.

  There is no separate tool-*result* part: a call and its output are one part, with the output in
  `state.output`. Canonical `tool_use`/`tool_result` blocks therefore have to be paired up front
  (the result usually rides on the *following* user turn) rather than while walking one turn's
  blocks. A result whose call is absent from the conversation has nowhere structured to go and is
  folded to labeled text, where at least the content survives.

  A foreign tool name (`Edit`, `Read`, …) is accepted; opencode renders `⚙ Read [file_path=…]`
  without attempting to resolve or re-run it.

## 6. Model identity

> **CORRECTED 2026-08-06 (1.18.5).** The assessment below was wrong in a way that broke every
> bridged opencode session from 2026-08-02 until it was found. It is kept, struck through, so
> the failure mode is recognizable if it recurs on another target.

turnbridge writes `modelID: <source model>` with `providerID: "turnbridge"`, per the old
fabrication-contract rule to propagate the source model id verbatim and never substitute a
recognized-but-false one.

~~Observed consequence on resume: opencode shows a one-time toast —
`Model turnbridge/<model> is not valid` — and the composer falls back to the user's configured
model, which is accurate: the bridge did change models. History renders in full either way.~~

**What actually happens.** The toast is real and the *composer* does fall back, but opencode's
**agent loop** resolves the model from the session's stored `providerID`/`modelID`, not from the
composer, `-m`, or the TUI model picker. There is no provider named `turnbridge`, so the loop
throws and exits before issuing any request:

```
ERROR message=failed error="ProviderModelNotFoundError: Model not found: turnbridge/<model>."
```

Logs show `loop step=0` → `exiting loop` with **no `stream` line**, where a native session logs
`process` → `stream` → `llm runtime selected`. No network request is made, so the provider is
never implicated. Symptoms depend on how the session is scoped: filed under a registered
project, `opencode run -s` exits **0 with empty output** and the TUI silently swallows the
prompt (it is persisted as a `user` message with no assistant reply); filed under `global`, it
surfaces as `UnknownError: Unexpected server error`. In both cases history renders in full — the
session is readable and un-continuable, which is why the TUI check missed it.

Patching only the four `"providerID": "turnbridge"` occurrences to `"opencode"`, changing nothing
else, restores continuation **and** the model correctly recalls a marker planted in the bridged
history. Fabrication was never at fault: the model does read bridged context.

The contract now says to propagate the source model id only where the target can resolve it, and
otherwise to write a resolvable value and disclose the real source model in the import notice —
`providerID` is a dispatch field, not a provenance field.

**What turnbridge does now.** At fabricate time it lists `opencode models` and resolves the
source model against it: an exact `provider/model`, or an unambiguous bare model id, is kept
verbatim (opencode→opencode, or a user who registered the same model, keeps its own). Otherwise
it takes the first listed model, records the substitution in the import notice
("The turns below were produced by X; this session continues with Y…") and in a launch note. If
`opencode models` yields nothing, fabrication throws `FabricationUnsupportedError` and falls back
to bootstrap rather than writing a session that cannot dispatch. The chosen model is only a
starting point: verified that `-m` overrides it on a bridged session (stored `big-pickle`, ran on
`deepseek-v4-flash-free`), which it could not do while the stored provider was unresolvable.

## 7. Verification log (1.18.5, 2026-08-02)

1. `opencode export` of a real 98-message session → ground-truth envelope (§3).
2. Text-only fabricated payload → imports, `session list` shows it, TUI renders both markers.
3. Same payload plus one `tool_use`/`tool_result` pair → **import fails**,
   `Missing key at ["state"]["title"]`; bisecting adds `metadata`, then `time`.
4. Failed import inspected: session present with 3 of 4 messages → import is not atomic.
5. `projectID: "global"` → session listed from an unrelated directory; looked-up project id →
   listed only from the repo. Both checked from two directories.
6. Backdated notice → renders first, `QUEUED` badge gone (pty capture).
7. Tool-bearing payload with all six `state` keys → imports, renders
   `⚙ Read [file_path=/tmp/x]`, assistant text and markers intact.
8. Human TUI inspection (2026-08-03, `scripts/smoke-interactive.mjs opencode --manual`,
   run in a normal terminal): render reported visually correct. This is the check a pty
   capture cannot make — see the note in that script about the Codex empty-scrollback bug,
   which a passing automated capture would not have caught.

## 8. Unknowns / risks

- **Live continuation is unverified.** Sending a new prompt into a resumed fabricated session
  (`opencode run -s <id> …`) could not be completed: the test machine's configured provider
  errored on a *native* session too (`metal resumed prefill failed`), so the failure was not
  attributable to fabrication. What is verified is that the history is present and renders
  correctly (§7.8) — not that the model, once answering, reads it. The equivalent probe for
  Codex (`scripts/probe-codex-content.mjs`) has no opencode analogue yet; writing one is the
  cheapest way to close this, since it needs no TUI.
- Whether the `Model … is not valid` toast has any effect beyond the composer fallback (e.g. on
  `--fork`, or on tool permissioning) was not probed.
- `opencode debug scrap` is a debug command; its output shape is not a stability promise. The
  adapter treats a parse failure as "no project" and falls back to `global`.
- The `project` table's id derivation is unknown (§3.1). If a future release lets `import`
  resolve the project from `info.directory`, the lookup could be dropped.
- Long histories (hundreds of turns) were not measured for this target;
  `scripts/probe-large-history.mjs` covers only the file-based targets.
- Capture (the other direction) is not part of this spec — it lives in conversation-ledger's
  opencode adapter (0.18.0+), which reads `opencode export` rather than the DB. Verified
  2026-08-03 that the two compose: a session fabricated by this adapter is captured back with
  its `thinking`, `tool_use`, and `tool_result` blocks and its propagated model id intact, and
  re-bridges into Codex and Claude Code with the tool call still structured. Note that
  fabrication writes `state.output` for a tool call while capture skips *unsettled* (`running`)
  tool calls — a bridged session therefore only ever carries completed ones, which is why the
  round trip is lossless here and might not be for a session captured mid-tool-call.
