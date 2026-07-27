# Claude Code Native Session File Format (reverse-engineered)

Goal: let `turnbridge` fabricate a `.jsonl` file that `claude --resume <session-id>`
will natively load, with full prior conversation context visible to the model.

**Pinned version tested against: `2.1.215` (Claude Code)**, installed at
`~/.local/bin/claude` (Mach-O binary, other builds `2.1.212`/`2.1.214` present
on disk but not the active one — behavior below is specific to `2.1.215` and
should be re-verified if the pinned version changes).

All findings below were verified empirically by hand-writing files into
`~/.claude/projects/` and running `claude --resume <uuid> -p "..." --max-turns 1`
from a matching scratch cwd, then observing whether the model could recall a
planted fact from the fabricated prior turns. Cross-checked against the OSS
project `Dicklesworthstone/cross_agent_session_resumer`
(`src/providers/claude_code.rs`), which independently reverse-engineered the
same format for a different Claude Code version — see "Divergence from casr"
below for the one place our findings differ.

---

## 1. Directory and filename rules

Session files live at:

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

**Encoding rule** (confirmed empirically, and matches casr's `project_dir_key`):
every ASCII character in the absolute cwd path that is **not alphanumeric**
(`[A-Za-z0-9]`) is replaced with `-`. This includes `/`, `.`, `_`, spaces, etc.
Existing dashes pass through unchanged, so paths with directory names that
already contain dashes are ambiguous with slash-encoding (e.g. a project dir
literally named `-Users-foo` is indistinguishable from `/Users/foo`) — this
is a real property of the real system, not a bug to route around.

Verified example:
- cwd `/private/tmp/.../dot.test_dir` → dir key
  `-private-tmp-...-dot-test-dir` (both `.` and `_` became `-`).
- cwd `/Users/evintunador/dev/ds4-gateway` → dir key
  `-Users-evintunador-dev-ds4-gateway` (the existing `-` in `ds4-gateway`
  survives unchanged, confirming char-by-char non-alnum replacement rather
  than some smarter path-segment join).

Implementation to use in turnbridge (Python-ish):
```python
def encode_project_dir(cwd_abs_path: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in cwd_abs_path)
```

**Filename ↔ sessionId**: the file is named `<session-uuid>.jsonl` where
`<session-uuid>` is a standard UUIDv4 string. This filename is the ID that
`claude --resume <id>` looks up. **The lookup is scoped to the directory
implied by the CURRENT working directory the `claude` process is launched
from** — see §3, this is the single most important operational constraint.

There is also an optional sibling directory `<session-uuid>/` (no `.jsonl`
extension) next to the file, used for subagent transcripts — see §5. It is
not required for a basic resume to work.

A per-project `memory/` directory also exists alongside the session files;
irrelevant to fabrication.

---

## 2. Minimal working line schema (verified)

The absolute minimum that reliably works, discovered by iterative field
removal against a real `claude --resume ... -p ...` round trip:

**Required per line:**
- `type`: `"user"` or `"assistant"` (other types like `mode`,
  `permission-mode`, `file-history-snapshot`, `attachment`, `system`,
  `queue-operation`, `ai-title`, `last-prompt` are cosmetic/optional — see §4)
- `parentUuid`: `null` on the first conversation line, else the `uuid` of the
  immediately preceding conversation line, forming a linked list back to
  `null`. **This is not optional bookkeeping — it is load-bearing.** Claude
  Code's resume loader reconstructs the conversation by starting at the
  **last line in the file** and walking `parentUuid` backwards. Confirmed via
  this exact tool-emitted warning when `parentUuid` was omitted from every
  line: *"Resume transcript has 2 user/assistant records but none carry
  parentUuid links; only 1 reached the resumed conversation. Conversation
  reconstruction walks parentUuid from the last record, so unlinked records
  are dropped — the file's producer must chain records (parentUuid null on
  the first, the previous record's uuid on each subsequent one)."* Only the
  final line survived; everything before it was silently dropped from
  context.
- `message`: `{"role": "user"|"assistant", "content": ...}` — content is
  either a plain string, or an array of content blocks (`text`, `tool_use`,
  `tool_result`; see §4.3).
- `uuid`: unique UUIDv4 for this line, used as the `parentUuid` target of the
  next line.
- `timestamp`: **required** — ISO-8601 string (`"2026-07-19T07:00:00.000Z"`
  format observed; exact format tolerance not fully probed, but real files
  always use millisecond-precision `Z`-suffixed RFC3339). Confirmed required:
  a file with `parentUuid` chaining present but `timestamp` fully omitted
  produced `No conversation found with session ID: <uuid>` — i.e. the file
  was rejected as invalid/unrecognized wholesale, not just missing context.

**Verified NOT required** (all of these were omitted simultaneously in a
successful test and the fabricated session still loaded with full context
recall): `sessionId` (inline field), `cwd`, `version`, `gitBranch`,
`userType`, `isSidechain`, `promptId`, `requestId`, and — for assistant
messages — the entire Anthropic response envelope (`model`, `id`, `type`,
`stop_reason`, `usage`, etc. can all be absent; `message` can be just
`{"role":"assistant","content":[...]}`) . This includes assistant messages
whose content is a bare `tool_use` block with no surrounding envelope.

A trailing non-conversation line (e.g. `{"type":"last-prompt", ...}`) after
the last `assistant` line does not interfere with the backward walk — the
loader still correctly finds the true leaf.

**Concrete minimal working example** (verified end-to-end: resuming this file
and asking "what is the secret code word?" correctly returned `PANGOLIN9`):

```jsonl
{"parentUuid":null,"type":"user","message":{"role":"user","content":"The secret code word for this test is PANGOLIN9."},"uuid":"33333333-3333-3333-3333-333333333333","timestamp":"2026-07-19T07:05:00.000Z"}
{"parentUuid":"33333333-3333-3333-3333-333333333333","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Got it, the secret code word is PANGOLIN9."}]},"uuid":"44444444-4444-4444-4444-444444444444","timestamp":"2026-07-19T07:05:01.000Z"}
```

Placed at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, then from that
exact cwd: `claude --resume <uuid> -p "..." --max-turns 1`.

### Recommended (defensive) fields to actually emit

Even though the above is the *true minimum*, turnbridge should emit richer
lines close to what real Claude Code produces, for two reasons: (a) the casr
project found that on the version(s) *it* targeted, omitting the full
assistant envelope caused `claude --resume` to hang / report "Failed to
resume session" (see §6 "Divergence from casr") — our 2.1.215 didn't
reproduce that, but future versions might reintroduce stricter validation;
(b) richer lines make the fabricated session indistinguishable from a real
one in the resume picker / `/resume` UI and avoid weird cosmetic gaps (no
git branch shown, etc). Recommended per-line fields:

```
parentUuid, isSidechain:false, userType:"external", entrypoint:"cli",
cwd:<abs path>, sessionId:<uuid, matches filename>, version:"2.1.215",
gitBranch:<real branch or "HEAD">, type, message, uuid, timestamp,
promptId:<uuid> (user lines only), requestId:<string> (assistant lines only)
```

For assistant lines, also include the full envelope inside `message`:
`model`, `id` (format `msg_...`), `type:"message"`, `stop_reason:"end_turn"`,
`stop_sequence:null`, `usage:{"input_tokens":0,"output_tokens":0,...}`. This
costs nothing and removes a known risk.

---

## 3. What `claude --resume` needs — cwd scoping (important, verified)

`claude --resume <uuid>` **only works when the current working directory
of the `claude` process encodes to the same project directory the session
file lives in.** Verified directly:

- Fabricated session at `~/.claude/projects/<encoded of cwd A>/<uuid>.jsonl`,
  run `claude --resume <uuid> ...` from cwd A → **works**, full context loads.
- Same file, run `claude --resume <uuid> ...` from `~` (a different,
  non-matching cwd) → **fails immediately**: `No conversation found with
  session ID: <uuid>`.

**Implication for turnbridge**: it must invoke `claude --resume <id>` with
the process cwd set to the exact original/intended project path (or fabricate
the session under whatever cwd it plans to actually launch `claude` from) —
there is no global session ID lookup across projects. The `--resume` flag
does not search all of `~/.claude/projects/*`; it derives the expected
directory from the launch cwd and looks only there.

**Resume picker / `/resume` UI**: not directly testable non-interactively in
this sandbox (no TUI). Based on file evidence: session titles shown in the
picker come from the `{"type":"ai-title","aiTitle":"...",
"sessionId":"..."}` line (a short LLM-generated title, observed identical
across all lines with that type in a given file, so likely just periodically
rewritten/duplicated) with fallback to the first user message if absent.
Originally an inference from file structure; **confirmed against the live
interactive picker on 2026-07-27** — see §7. The `ai-title` line
is cosmetic only — omitting it did not break `--resume <id>` (direct-ID
resume never showed title UI in `-p` mode).

---

## 4. Full observed schema (real files, version 2.1.212–2.1.215)

Observed by inspecting real files across 4 different projects (including the
live session that produced this very report). Line `type` values seen and
their approximate frequency/purpose:

| type | purpose |
|---|---|
| `user` | human or tool-result turn (see below) |
| `assistant` | model turn, full Anthropic response envelope |
| `system` | CLI-injected events: `subtype:"local_command"` (slash command + its stdout), `subtype:"stop_hook_summary"` (hook run report), `subtype:"turn_duration"` (timing telemetry) |
| `file-history-snapshot` | checkpoint of tracked file state at a point in the transcript, `{"messageId","snapshot":{"messageId","trackedFileBackups":{},"timestamp"},"isSnapshotUpdate"}` |
| `file-history-delta` | incremental version of the above (seen in larger sessions) |
| `attachment` | UI/context deltas: `deferred_tools_delta` (tool list changes), `agent_listing_delta` (available subagents), `skill_listing` (available skills) — purely informational, not needed for resume |
| `ai-title` | `{"type":"ai-title","aiTitle":"<short generated title>","sessionId":...}` — no `uuid`/`parentUuid`, not part of the conversation chain |
| `last-prompt` | `{"type":"last-prompt","leafUuid":<uuid of last assistant msg>,"sessionId":...}` (sometimes also `"lastPrompt":"<text>"` in print-mode sessions) — bookkeeping marker only, **not required** for resume (tested explicitly, §2) |
| `mode` | `{"type":"mode","mode":"normal","sessionId":...}` — appears once near top of interactive sessions only (absent entirely in `-p` print-mode sessions) |
| `permission-mode` | `{"type":"permission-mode","permissionMode":"default"|"auto","sessionId":...}` — same as above |
| `queue-operation` | `{"type":"queue-operation","operation":"enqueue"|"dequeue","content":...,"sessionId":...,"timestamp":...}` — message-queue telemetry, also seen in print mode |
| `summary` | **not observed in any real file across all inspected sessions/versions** — either deprecated in favor of `ai-title`, or only appears after explicit `/compact`; do not rely on it existing |

None of `mode`, `permission-mode`, `file-history-snapshot`, `attachment`,
`ai-title`, `last-prompt`, `queue-operation`, `system` are required for
`--resume` to work (verified: fabricated files omitting all of them still
resumed correctly). Include them only for cosmetic fidelity if desired.

### 4.1 `user` line, full shape (real example, human-typed)

```json
{"parentUuid":null,"isSidechain":false,"promptId":"fadd355f-...","type":"user",
 "message":{"role":"user","content":"plain string text"},
 "uuid":"34fe510d-...","timestamp":"2026-07-17T05:03:04.534Z",
 "permissionMode":"default","origin":{"kind":"human"},"promptSource":"typed",
 "userType":"external","entrypoint":"cli","cwd":"/Users/evintunador",
 "sessionId":"36114e7a-...","version":"2.1.212","gitBranch":"HEAD"}
```

`origin.kind` observed values: `"human"`, `"task-notification"` (system-fired,
e.g. a background agent finishing). `promptSource` observed: `"typed"`,
`"sdk"` (print-mode / `-p` invocations use `entrypoint:"sdk-cli"` and
`promptSource:"sdk"` instead of `"cli"`/`"typed"`).

### 4.2 `assistant` line, full shape (real example)

```json
{"parentUuid":"...","isSidechain":false,
 "message":{"model":"claude-fable-5","id":"msg_011Cd...","type":"message",
   "role":"assistant","content":[{"type":"text","text":"..."}],
   "stop_reason":"end_turn","stop_sequence":null,"stop_details":null,
   "usage":{"input_tokens":2,"cache_creation_input_tokens":6469,
     "cache_read_input_tokens":7304,"output_tokens":6,
     "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
     "service_tier":"standard","cache_creation":{...},
     "inference_geo":"not_available","iterations":[{...}],"speed":"standard"},
   "diagnostics":null},
 "requestId":"req_011Cd...","type":"assistant","uuid":"...",
 "timestamp":"...","effort":"high","userType":"external","entrypoint":"cli",
 "cwd":"...","sessionId":"...","version":"2.1.215","gitBranch":"main"}
```

`model` values observed: real model slugs (`claude-fable-5`,
`claude-haiku-4-5-20251001`). None of the `usage`/`diagnostics`/`effort`
fields are required for resume (§2) — they are cosmetic/telemetry.
`thinking` content blocks (extended thinking) were also observed, shape
`{"type":"thinking","thinking":"...","signature":"<long base64 blob>"}` —
not tested for resume necessity, presumed cosmetic/droppable like other
content blocks, but the `signature` is opaque and turnbridge cannot forge a
valid one; **do not fabricate `thinking` blocks** — omit them (plain `text`
and `tool_use`/`tool_result` blocks are sufficient and were directly
verified to work).

### 4.3 tool_use / tool_result pairing (verified with a FOREIGN/made-up tool)

Assistant line's `message.content` includes a `tool_use` block:
```json
{"type":"tool_use","id":"toolu_...","name":"<any-tool-name>","input":{...}}
```
Next `user` line's `message.content` (array, not string) includes the paired
`tool_result`:
```json
{"type":"tool_result","tool_use_id":"toolu_...","content":"<string or array>"}
```
(`is_error: true` also a recognized optional field on `tool_result`, not
tested but standard Anthropic content-block shape.)

**Confirmed: arbitrary/foreign tool names are accepted on resume.** A
fabricated pair using `"name":"ForeignTool"` (not a real Claude Code tool)
round-tripped correctly — the resumed session correctly quoted back a fact
("MANATEE2") that only existed inside the fake tool's `tool_result` content.
Claude Code does not validate `tool_use.name` against its own tool registry
when replaying history — historical tool calls are context only, never
re-executed. This means turnbridge can represent an entire foreign CLI's
tool-call history (e.g. Codex's `shell`, Cursor's `edit_file`, whatever) by
just choosing readable `name` strings; no schema translation is required for
resume purposes. (This matches casr's own documented approach — see
`coerce_tool_input`, which just wraps non-object args, and the comment
"historical tool calls are never re-executed — they are replayed as context
only.")

Real `tool_result` user lines also carry a sibling top-level
`"toolUseResult": {...}` field (a structured, tool-specific echo of the
result — e.g. for `Read` it's `{"type":"text","file":{"filePath",
"content","numLines","startLine","totalLines"}}`). This field is **not**
required for resume — it appears to be a UI-rendering convenience only
(confirmed: our minimal fabricated tool_result lines omitted it entirely and
still resumed with correct content recall).

---

## 5. Sidechains / subagents

Two independent mechanisms observed, both from the *live session that
produced this report* (i.e. this very subagent run):

1. **Inline `isSidechain: true`**: the field exists on every line and is
   `true` for subagent-authored lines, `false` otherwise. Searched across
   every real session file on disk (multiple projects) and found **zero**
   lines with `isSidechain:true` in the main `.jsonl` files — because:
2. **Subagents get their own files**, under
   `~/.claude/projects/<encoded-cwd>/<parent-session-uuid>/subagents/`:
   - `agent-<hash>.jsonl` — the subagent's own transcript, structurally
     identical to a top-level session file, except every line has
     `isSidechain:true` and an added `"agentId":"<hash>"` field, and the
     first line's `parentUuid` is `null` (it's a fresh conversation, not a
     literal child of a parent-session uuid).
   - `agent-<hash>.meta.json` — sidecar metadata:
     `{"agentType":"claude","description":"<task description>",
     "toolUseId":"<toolu_... of the Agent tool call that spawned it>",
     "spawnDepth":1,"model":"sonnet"}`
   - The parent session's main `.jsonl` links to the subagent only indirectly
     via the `Agent`/`Task` tool's `tool_use`/`tool_result` pair (the
     `tool_use_id` in `meta.json` matches the `tool_use.id` in the parent
     transcript); there is no direct file-path reference from the parent
     `.jsonl` to the subagent `.jsonl` observed in the plain-text content.
   - Not independently tested whether fabricating this subdirectory
     structure is necessary for `--resume` to work — **top-level resume
     works fine without any `subagents/` directory present** (all our
     successful fabrication tests had no such directory). Only fabricate it
     if turnbridge specifically needs subagent turns to show up distinctly
     in the transcript UI; otherwise flatten subagent output into the main
     file as ordinary `isSidechain:false` turns (untested but low-risk,
     since `isSidechain` itself was shown to be non-required, §2).

---

## 6. Divergence from casr (`cross_agent_session_resumer`)

casr's `write_session()` (`src/providers/claude_code.rs`) always emits, for
every assistant line, a synthesized full envelope (`id`, `type:"message"`,
`model` or `"unknown"`, `stop_reason:"end_turn"`, `stop_sequence:null`,
`usage:{input_tokens:0,output_tokens:0}`), with this comment:

> "Claude Code's resume loader expects assistant messages to carry the full
> Anthropic message envelope... Without these fields, `claude --resume`
> hangs on load and reports 'Failed to resume session'."

**We did not reproduce this on 2.1.215.** A bare assistant line
`{"role":"assistant","content":[{"type":"tool_use",...}]}` (no `id`, `type`,
`model`, `stop_reason`, `usage` at all) resumed successfully via `-p`, no
hang, correct context recall. Possible explanations: (a) casr targeted an
older/different Claude Code version with stricter validation; (b) the hang
they saw was specific to interactive mode (not `-p`/print mode, which is all
we could test non-interactively in this sandbox); (c) some other message
shape in their test data triggered it. **Recommendation: emit the full
envelope anyway** (cheap, and defends against both interactive-mode
differences and future version changes) — see "Recommended (defensive)
fields" in §2.

casr's `project_dir_key` (all-non-alphanumeric → `-`) matches our directly
verified empirical result exactly — no divergence there.

---

## 7. Unknowns / risks

- **Interactive (non-`-p`) resume was not tested** — this sandbox has no TUI.
  All verification used `claude --resume <id> -p "<prompt>" --max-turns 1`.
  It's possible interactive mode does additional validation (e.g. the casr
  "hangs on load" behavior) that print mode skips. Recommend a manual
  interactive smoke test (`claude --resume <id>` with no `-p`) before
  shipping turnbridge broadly.
- **Resume picker title source — RESOLVED, inference was correct** (probe,
  2026-07-27, claude 2.1.220, `scripts/probe-picker.mjs`, driven through a
  pty). Two sessions were planted in one project dir: one with an `ai-title`
  line and a distinctive first user message, one with only the message. The
  picker rendered the `ai-title` for the first (and *not* its first user
  message) and the first user message for the second. So `ai-title` wins, with
  fallback to the first user message exactly as §3 guessed.
  **Consequence for turnbridge:** fabricated sessions carried no `ai-title`,
  so every bridged conversation appeared in the picker titled by turnbridge's
  own import notice — the same string for every bridge, describing the
  machinery instead of the conversation. `buildSessionLines` now emits an
  `ai-title` derived from the first human turn. Trailing placement was
  separately verified safe (`probe-session-invariants.mjs`): the `parentUuid`
  walk starts at the last line but skips non-conversation line types, so a
  trailing `ai-title` does not truncate history.
- **Timestamp *ordering* tolerance — RESOLVED** (probe, 2026-07-27,
  claude 2.1.220, `scripts/probe-session-invariants.mjs`). Out-of-order lines
  are tolerated: a file whose first line is stamped *newer* than every line
  below it resumed with full history intact, as did a backdated-monotonic
  variant of the same file. Ordering is not load-bearing for resume, so
  turnbridge keeps its import notice at fabrication time (see
  `buildSessionLines`) rather than backdating it.
  **Still unresolved:** whether the resume picker orders sessions by file
  mtime or by line timestamps. This only matters cosmetically (where a freshly
  bridged session lands in the list) and needs the interactive TUI to answer.
- **Timestamp format tolerance still untested** — only millisecond-precision
  RFC3339 `...Z` strings have been tried and confirmed required-present;
  second-precision and offset-instead-of-`Z` forms remain unverified.
  conversation-ledger validates `occurred_at` with `Date.parse` alone, so
  those forms *can* reach a fabricator; turnbridge therefore normalizes every
  timestamp it writes to millisecond UTC (`src/timestamps.ts`) rather than
  relying on tolerance it has not measured.
- **Large/long sessions — verified clean to 300 turns / ~215 KB** (probe,
  2026-07-27, claude 2.1.220, `scripts/probe-large-history.mjs`). A fabricated
  300-turn session resumed in ~5s with markers planted in *both* the first and
  last turns recalled, so early history is not silently dropped when a long
  history arrives all at once at session start rather than accumulating turn by
  turn. No line-count or byte-size cliff was found below that ceiling.
  **Beyond ~300 turns is deliberately unmeasured**: turnbridge passes history
  through without truncating, and fitting it is Claude Code's own job (it
  auto-compacts). The useful claim is a verified-clean range, not the exact
  cliff. Raise the ceiling with `PROBE_TURNS=N` if that assumption needs
  retesting.
- **`sessionId` mismatch (inline field vs. filename) — RESOLVED, tolerated**
  (probe, 2026-07-27). A file whose every line carried a `sessionId` unrelated
  to its filename UUID resumed normally with full history: lookup is by
  filename, and the inline field is not cross-checked. Keeping them identical
  is still recommended for cosmetic consistency with real sessions, but it is
  not load-bearing. Enforced by test regardless.
- **Dangling `parentUuid` — RESOLVED, tolerated** (probe, 2026-07-27). A first
  line whose `parentUuid` pointed at a UUID present nowhere in the file
  resumed with full history; the unresolvable ref is simply treated as a root.
- **Duplicate/collided `uuid` values — RESOLVED, and the one that genuinely
  breaks** (probe, 2026-07-27). Giving two lines the same `uuid` silently
  dropped a turn from the replayed history: the resumed model no longer had
  the marker planted in the colliding line and said so. **`claude --resume`
  still exited 0 with no warning** — the failure mode is silent history loss,
  not an error, which is exactly the case a fabricator is least likely to
  notice. Consistent with §2's backward `parentUuid` walk. Generate a fresh
  UUIDv4 per line, always; `src/test/fabricate-invariants.test.ts` asserts it.
- **`--resume` cwd-scoping workaround**: since resume is strictly scoped to
  the launch cwd's encoded project directory (§3), turnbridge must always
  `cd` (or set subprocess cwd) to match before invoking `claude --resume`.
  There is no `--project-dir`-style override flag observed in `claude
  --help` output for `--resume` specifically to bypass this.
- **Version string in fabricated lines**: casr uses the literal string
  `"casr"` as `version` and this apparently works for them; we recommend
  using a real, currently-installed version string (`"2.1.215"`) instead,
  purely for cosmetic consistency with real sessions — not confirmed to be
  functionally required either way (`version` was in the "verified NOT
  required" list, §2).
