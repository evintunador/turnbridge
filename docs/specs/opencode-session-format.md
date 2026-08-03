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

## 5. Parts

Observed types: `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `patch`.

Every part carries `id` (`prt_…`), `sessionID`, `messageID`.

- **`text`** — `{ type, text, id, sessionID, messageID }`. Minimal and always accepted.
- **`reasoning`** — as `text` plus `time: { start, end }`. Renders as a collapsed
  `+ Thought: <duration>` line.
- **`step-start`** — real assistant messages begin with one (carrying a `snapshot` git sha).
  **Not required**: fabricated assistant messages with no `step-start` render their text
  normally. turnbridge omits it rather than inventing a snapshot id.
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

The fabrication contract (docs/WIP_TECHNICAL_DESIGN.md) says to propagate the source model id
verbatim and never substitute a recognized-but-false one. turnbridge writes
`modelID: <source model>` with `providerID: "turnbridge"`.

Observed consequence on resume: opencode shows a one-time toast —
`Model turnbridge/<model> is not valid` — and the composer falls back to the user's configured
model, which is accurate: the bridge did change models. History renders in full either way.

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

## 8. Unknowns / risks

- **Live continuation is unverified.** Sending a new prompt into a resumed fabricated session
  (`opencode run -s <id> …`) could not be completed: the test machine's configured provider
  errored on a *native* session too (`metal resumed prefill failed`), so the failure was not
  attributable to fabrication. What is verified is that the history is present and renders. The
  equivalent probe for Codex (`scripts/probe-codex-content.mjs`) has no opencode analogue yet.
- Whether the `Model … is not valid` toast has any effect beyond the composer fallback (e.g. on
  `--fork`, or on tool permissioning) was not probed.
- `opencode debug scrap` is a debug command; its output shape is not a stability promise. The
  adapter treats a parse failure as "no project" and falls back to `global`.
- The `project` table's id derivation is unknown (§3.1). If a future release lets `import`
  resolve the project from `info.directory`, the lookup could be dropped.
- Long histories (hundreds of turns) were not measured for this target;
  `scripts/probe-large-history.mjs` covers only the file-based targets.
- Capture (the other direction) is not part of this spec: it needs conversation-ledger's
  opencode adapter, which is a separate package.
