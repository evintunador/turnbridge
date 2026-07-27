# Codex CLI native "rollout" session file format — reverse-engineering spec

Purpose: enable `turnbridge` to FABRICATE a `~/.codex/sessions/.../rollout-*.jsonl` file that
Codex's native `resume` (both interactive TUI and `codex exec resume`) will load with the
fabricated prior conversation visible to the model.

Pinned environment:
- `codex --version` → **codex-cli 0.144.6** (some session files on disk were written by 0.144.5;
  format is stable across that point release).
- Tested on macOS (darwin), zsh shell, `$CODEX_HOME` = `~/.codex` (default).

Everything in this document was verified empirically against this exact build on 2026-07-18/19,
by hand-writing fabricated rollout files and confirming Codex resumed them with visible prior
context (see "Verification experiment" below). It is not derived solely from docs or other
projects' guesses.

---

## 1. Resume command forms

### Interactive (TUI)
```
codex resume [SESSION_ID] [PROMPT] [OPTIONS]
```
- `SESSION_ID` — a UUID (any version; v4 works, not just v7 — see §6) **or** a session *name*.
  If parseable as a UUID it's treated as an id, not a name.
- If `SESSION_ID` is omitted: shows an interactive **picker** listing recorded sessions.
  - The picker **filters by current working directory** by default (only sessions whose
    `session_meta.cwd` matches — exact mechanism not further probed, but `--all` explicitly
    "disables cwd filtering").
  - `--last` bypasses the picker and resumes the most recently recorded session (still cwd
    -filtered unless combined with `--all`).
  - `--all` shows all sessions regardless of cwd, and adds a CWD column.
  - `--include-non-interactive` — only meaningful for the picker; non-interactive (`exec`-
    originated) sessions are excluded from the picker/`--last` selection unless passed.
- Requires a real TTY. In a non-tty environment it fails immediately with
  `Error: stdin is not a terminal` (verified) — this happens *before* any session-content
  validation as far as we could tell; when run inside a pty (via `script`), it proceeded past
  that check and began rendering the TUI (terminal capability query escape sequences observed),
  i.e. it did **not** reject our fabricated file.
- `[PROMPT]` optional — if given, is sent as the first new user turn immediately after resuming.

### Non-interactive (scriptable) — **this is the form to target for programmatic fabrication/verification**
```
codex exec resume [SESSION_ID] [PROMPT] [OPTIONS]
```
- Same `SESSION_ID` semantics as above (`--last` and `--all` also present).
- `--json` — print NDJSON events to stdout (`thread.started`, `turn.started`,
  `item.completed`, `turn.completed`, ...). This is the reliable way to script verification.
- `--skip-git-repo-check` — needed if invoked outside a git repo, or if the fabricated file's
  target cwd differs from where `codex` was actually launched.
- `--dangerously-bypass-approvals-and-sandbox` — needed if you want the resumed agent to
  actually run shell commands without prompting (used only for one diagnostic test below).
- **Important finding**: resume-by-id works from **any** current working directory — cwd
  filtering only applies to the *picker*, not to direct-id resume. The actual working directory
  the resumed agent operates in is the **process's real cwd at invocation time** (i.e. wherever
  you ran `codex exec resume` from), **not** the fabricated `session_meta.cwd` value. We
  verified this directly: resumed a session whose fabricated `cwd` pointed at a scratch repo,
  invoked `codex exec resume` from `/tmp` instead, and asked the agent to run `pwd` — it printed
  `/tmp`. So `session_meta.cwd` is effectively cosmetic/display metadata (used for the picker's
  cwd filter and any UI that shows "resumed session in <dir>"), not authoritative for execution.
  Implication for turnbridge: set `cwd` to whatever you want *displayed*/matched by the picker,
  but don't rely on it to sandbox or root the resumed agent — that's controlled by the real
  invocation cwd / `-C`/`--cd`.

---

## 2. File/directory naming rules

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local-timestamp>-<uuid>.jsonl
```
- `$CODEX_HOME` defaults to `~/.codex`; sessions live under `$CODEX_HOME/sessions`.
- `<YYYY>/<MM>/<DD>` is the **local** date (not UTC) at session-creation time. Verified: local
  clock was `2026-07-18 23:59 PDT` while the in-file UTC timestamps read `2026-07-19T06:59...Z`,
  and the file was correctly placed under `.../2026/07/18/`.
- `<local-timestamp>` in the filename is local time, format `YYYY-MM-DDTHH-MM-SS` (colons
  replaced with hyphens, seconds precision, no milliseconds, no offset suffix).
  Example real filename: `rollout-2026-07-18T16-16-52-019f7784-b1c3-7561-9237-586478b394d2.jsonl`.
- `<uuid>` is the session id, **and must exactly match** `session_meta.payload.id` /
  `.session_id` inside the file (this is how `resume <id>` locates the file — presumably an
  index/scan over the sessions dir matching this literal id, since resume-by-id worked
  immediately with no separate registration step).
- UUID format: does not need to be UUIDv7. A real random UUIDv4 was accepted and resumed
  successfully. (Real Codex-generated ids happen to be UUIDv7 — time-ordered, e.g.
  `019f776a-c87a-7990-b54f-8040658be7fd` — presumably just because that's what Codex's own id
  generator emits, not because resume validates the version nibble.)
- All timestamps *inside* the JSONL (`timestamp` fields) are UTC, ISO-8601 with `Z` suffix and
  millisecond precision, e.g. `"2026-07-18T22:48:34.755Z"`.
- One session = one file. Lines are newline-delimited JSON objects (JSONL), UTF-8. Some real
  files contain raw literal control characters inside string values in a way that breaks strict
  parsers like `jq` (`jq: parse error: Invalid string: control characters...`) but that Python's
  `json.loads` parses fine — i.e. Codex's own writer does not always escape control bytes
  (likely raw terminal/ANSI bytes captured from shell output pass through un-escaped in some
  version of the writer). **When fabricating**, always produce properly-escaped JSON (use a real
  JSON serializer) — there's no reason to reproduce that quirk, and doing so risks a genuinely
  invalid file.

---

## 3. Minimal fabricated schema that VERIFIABLY WORKS

This is the maximally stripped-down version we tested and confirmed loads correctly via
`codex exec resume` (model echoed back a planted "secret code word", proving it read the
fabricated history) — and via `codex resume` (TUI started rendering without error, using a pty).

Three lines total. `session_meta` needs only 5 payload fields; each conversation turn needs only
a bare `response_item` message.

```jsonl
{"timestamp": "2026-07-19T07:00:34.000Z", "type": "session_meta", "payload": {"id": "019f792d-38dc-7cc7-a2d1-072e8cb04002", "timestamp": "2026-07-19T07:00:34.000Z", "cwd": "/some/dir", "originator": "codex_exec", "cli_version": "0.144.6"}}
{"timestamp": "2026-07-19T07:00:34.000Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "The secret code word for this test is PLUMFISH42. Remember it."}]}}
{"timestamp": "2026-07-19T07:00:34.000Z", "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Got it, the secret code word is PLUMFISH42."}]}}
```

Verified NOT required for `exec resume` to work and see full context:
- `session_meta.payload.session_id` (only `.id` was present; both usually appear in real files —
  recommend including both for safety/forward-compat, but `.id` alone sufficed in our test)
- `source`, `thread_source`, `model_provider`, `history_mode`, `context_window`, `git`,
  `base_instructions` — all omitted in the minimal test and it still worked.
- No `turn_context`, `world_state`, or `event_msg` lines at all are required for the resumed
  model to see/use prior conversation content. Those record types appear to be informational /
  UI-facing (token counters, sandbox/approval settings snapshots, TUI rendering aids) rather than
  part of what gets replayed into the model's context. **`response_item` lines are the actual
  conversation state that gets replayed.**
- `response_item.payload.message.id` — not required (real assistant messages have one, e.g.
  `"msg_0850eb109f..."`, but omitting it did not break resume).

Recommended (not strictly required, but cheap and matches real files, reduces risk of edge
cases in other code paths like the picker or future Codex versions that might start requiring
them):
```jsonl
{"timestamp": "<UTC-ISO-ms-Z>", "type": "session_meta", "payload": {
  "session_id": "<uuid>", "id": "<uuid>", "timestamp": "<UTC-ISO-ms-Z>",
  "cwd": "<display-dir>", "originator": "codex_exec", "cli_version": "0.144.6",
  "source": "exec", "thread_source": "user", "model_provider": "openai",
  "history_mode": "legacy"
}}
```
`history_mode` was `"legacy"` on every real file inspected (only value observed).

---

## 4. Full observed schema (from real files)

Top-level line shape is always: `{"timestamp": <UTC ISO>, "type": <string>, "payload": {...}}`.
Observed `type` values: `session_meta`, `event_msg`, `response_item`, `turn_context`,
`world_state`, `compacted`.

### 4.1 `session_meta` (always line 1)
Full field set seen across files (union; not all present in every file):
```
payload.session_id        string uuid
payload.id                string uuid   (== session_id; both present in normal (non-fabricated) files)
payload.timestamp         UTC ISO ms
payload.cwd                string path
payload.originator         "codex-tui" | "codex_exec"
payload.cli_version         e.g. "0.144.6"
payload.source              "cli" | "exec" | {"subagent": {"thread_spawn": {...}}}  (object form for spawned sub-agent sessions)
payload.thread_source       "user" | "subagent"
payload.model_provider      "openai"
payload.base_instructions   {"text": "<full system prompt, ~18KB>"}
payload.history_mode        "legacy"
payload.context_window      {"window_id": "<uuid>"}
payload.git                 {"commit_hash": str, "branch": str, "repository_url": str}   (present only when cwd is inside a git repo)
payload.forked_from_id      uuid   (only on forked/sub-agent sessions)
payload.parent_thread_id    uuid   (only on forked/sub-agent sessions)
payload.agent_nickname      string (only on sub-agent sessions, e.g. "Lagrange")
payload.agent_path          string (only on sub-agent sessions, e.g. "/root/quality_audit")
payload.multi_agent_version "v2"   (only on sub-agent sessions)
```

### 4.2 `event_msg` — UI/telemetry events, NOT required for context replay
Observed `payload.type` values and shapes:
- `task_started` — `{turn_id, started_at, model_context_window, collaboration_mode_kind}`
- `user_message` — `{message, images, local_images, text_elements}`
- `agent_message` — `{message, phase: "final_answer", memory_citation}`
- `token_count` — `{info: {total_token_usage:{...}, last_token_usage:{...}, model_context_window}, rate_limits: {...}}`
- `patch_apply_end` — `{call_id, turn_id, stdout, stderr, success, changes: {<path>: {type: "add"|..., content}}, status}`
- `task_complete` — `{turn_id, last_agent_message, completed_at, duration_ms, time_to_first_token_ms}`

### 4.3 `response_item` — the actual conversation payload replayed to the model
`payload.type` variants observed:
- **`message`** — `{type:"message", role: "developer"|"user"|"assistant", id?, content: [...], phase?, internal_chat_message_metadata_passthrough?: {turn_id}}`.
  - Content blocks: `{"type":"input_text","text":...}` for developer/user roles;
    `{"type":"output_text","text":...}` for assistant role.
  - `role: "developer"` is used for system-injected instructions (permission/sandbox rules,
    multi-agent framework instructions) — these are just more `message` items, not a special
    record type.
  - `id` (assistant messages only) looks like `"msg_<hex>"`.
- **`reasoning`** — `{type:"reasoning", id:"rs_<hex>", summary: [], encrypted_content: "<opaque base64-ish blob, ~2-4KB>", internal_chat_message_metadata_passthrough}`.
  `encrypted_content` is opaque ciphertext from OpenAI's Responses API (server-side reasoning
  encryption) — **cannot be fabricated** (no key available client-side) and is safe to simply
  **omit entirely**. We omitted all reasoning items in our fabricated files and resume worked
  fine; the model just doesn't get fabricated "prior reasoning," which is fine since reasoning
  items are not required for it to see/use prior message content.
- **`function_call`** / **`function_call_output`** — standard OpenAI Responses-style tool call
  pairs, linked by `call_id`. Seen used for a `"wait"` tool in this build.
  `function_call`: `{type, id:"fc_<hex>", name, arguments:"<json string>", call_id}`.
  `function_call_output`: `{type, call_id, output: [{"type":"input_text","text":...}, ...]}`.
- **`custom_tool_call`** / **`custom_tool_call_output`** — this specific build's primary
  shell/tool mechanism is a "custom tool" named `exec` whose `input` is a **JavaScript snippet**
  that calls higher-level runtime functions like `tools.exec_command({...})` and
  `tools.apply_patch(patchString)`, then `text(...)`s the result. Shape:
  `custom_tool_call`: `{type, id:"ctc_<hex>", status:"completed", call_id, name:"exec", input:"<js source>", internal_chat_message_metadata_passthrough}`.
  `custom_tool_call_output`: `{type, call_id, output:[{"type":"input_text","text":"Script completed\nWall time N seconds\nOutput:\n"}, {"type":"input_text","text":"<captured stdout>"}]}`.
  **This is specific to this Codex build/config (0.144.6 with an agentic "exec"-as-JS-runtime
  tool) and should not be assumed stable or universal** — it's notably different from the
  classic documented Codex `local_shell_call`/`shell` function-call shape used by older
  versions and by the `cross_agent_session_resumer` project (see §7). Don't try to fabricate
  `custom_tool_call` records expecting the model to treat them as "just happened" tool calls
  with guaranteed-consistent semantics across Codex versions.

### 4.4 `turn_context` — per-turn settings snapshot
```
{turn_id, cwd, workspace_roots:[...], current_date, timezone, approval_policy, approvals_reviewer,
 sandbox_policy:{type}, permission_profile:{...}, model, comp_hash, personality,
 collaboration_mode:{mode, settings:{model, reasoning_effort, developer_instructions}},
 multi_agent_version, multi_agent_mode, realtime_active, effort, summary}
```
Confirmed NOT required for resume (omitted in minimal fabrication; worked fine).

### 4.5 `world_state`
```
{full: true, state: {agents_md:{}, apps_instructions: bool, environments:{environments:{<name>:{cwd,status,shell}}, current_date, timezone, filesystem: "<xml-ish string>"}, plugins_instructions: bool, skills:{includeInstructions: bool}}}
```
Also confirmed not required.

### 4.6 `compacted` — history-compaction marker
Appears when Codex auto-compacts long history. Shape:
```
{message: "", replacement_history: [ <array of response_item-shaped message objects that replace the earlier raw history> ]}
```
Not needed for fabrication of a short session; relevant only if turnbridge wants to fabricate a
session that *looks like* it went through compaction (e.g. to hide raw tool noise while keeping
a condensed summary). `replacement_history` entries are plain `message` items with the same
shape as §4.3, so this is really just "inject condensed message items and mark them as a
compaction event" — low risk to fabricate the same way as regular messages if ever needed.

---

## 5. Representing foreign tool calls (e.g., Claude `tool_use`/`tool_result`)

> **Superseded in part — see §5.1.** The recommendation below was written when
> `function_call` replay was an untested risk. It has since been tested and is safe for
> *paired* calls, which turnbridge now emits. The reasoning is kept because it still
> explains the unpaired and `custom_tool_call` cases, which remain text-folded.

**Original recommendation: fold foreign tool calls into plain `message` content
(input_text/output_text), not into `function_call`/`function_call_output` or `custom_tool_call`
records.**

Reasoning:
- The only two `response_item` shapes we verified Codex will read back cleanly, with zero risk,
  are plain `message` items with `input_text`/`output_text` content blocks. This was directly
  tested and confirmed (planted a fact in a `user` message, got it echoed back correctly from a
  fabricated `assistant` message — full round trip).
- `function_call`/`function_call_output` pairs are standard OpenAI Responses API constructs, but
  they typically require the `call_id` to correspond to something the API/backend considers
  consistent, and (per general Responses API behavior) an orphaned `function_call_output` with
  no matching `function_call` — or a `name` that doesn't match any tool the model currently has
  registered — is a plausible source of a rejected request when the history is next sent to the
  model. We did not test this failure mode directly (out of scope/time), so treat it as an
  **unverified risk**, not a confirmed break.
- `custom_tool_call` is specific to this build's "exec-as-JS" tool wiring (§4.3) and even less
  safe to fabricate generically.
- Folding into message text sidesteps all of this: e.g. represent a Claude `tool_use` +
  `tool_result` pair as a single `assistant` message whose text includes something like:
  ```
  [used tool: Bash]
  command: pytest -q
  result: 3 passed, 0 failed
  ```
  This is exactly the strategy the `cross_agent_session_resumer` (`casr`) project uses for
  *its own* "user messages with tool content" case — see §7 — though `casr`'s code (per a
  secondary/unverified source excerpt) also attempts a `"type":"tool_use"` content block
  inline in `message.content`, which is **not** a content-block type we observed in any real
  Codex-authored `response_item.message.content` (`input_text`/`output_text` are the only two
  observed). Prefer the plain-text-folding approach unless/until `tool_use` blocks are
  separately verified against a live Codex install.
- For turnbridge's stated goal (make the resumed agent aware of what happened, not literally
  re-execute historical tool calls), folding into message text is strictly sufficient — verified
  by our experiment — and avoids every open question about tool-schema/call_id validation.

---

## 5.1 Structured tool replay (verified 2026-07-27, codex-cli 0.145.0)

`scripts/probe-codex-function-call.mjs` tested the risk §5 declined to test. Against a live
Codex, three fabricated histories:

| variant | resume result |
|---|---|
| text-folded (the old behavior) | history intact, tool named |
| **paired `function_call` + `function_call_output`, foreign `name`** | **history intact, tool named, no rejection** |
| orphaned `function_call_output` | no error, but the tool's identity is gone |

So a foreign tool name is *not* rejected, and `call_id` is not validated against anything the
backend knows. What matters is pairing.

turnbridge therefore emits, for the Codex target:

- a `tool_use` block → `function_call` response_item, `name` verbatim, `call_id` = the source
  tool-use id, `arguments` as a **JSON string** (not an object — the Responses API requires it);
- a `tool_result` block whose `tool_use_id` matches a call seen earlier in the same conversation
  → `function_call_output` with that `call_id`;
- an **unpaired** `tool_result` → plain text (`[tool result] …`), since an orphaned output would
  silently discard the tool name;
- `custom_tool_call` → never fabricated; still unverified.

Codex has no generic tool-call `event_msg` type (only tool-specific ones like `patch_apply_end`),
so a `function_call` alone is invisible in TUI scrollback. Since `event_msg` is display-only and
`response_item` is what the model reads, turnbridge writes both: the structured item for the
model and an `agent_message` twin for the human. Neither duplicates the other in model context.

Historical tool calls are context, never re-executed.

---

## 6. Session id / UUID requirements

- Any syntactically valid UUID works (tested UUIDv4 successfully; real Codex-generated ids are
  UUIDv7 but that's not enforced by resume).
- The id in the filename and `session_meta.payload.id` (and `.session_id`, if present) must all
  match exactly.
- No separate registration/index step observed — dropping a correctly-named, correctly-placed
  file into the dated sessions directory is sufficient; `resume <id>` found it immediately with
  no other action taken (no `codex sessions rebuild-index` or similar was needed).

---

## 7. Cross-check: `cross_agent_session_resumer` (casr)

Fetched via WebFetch (README + best-effort raw source fetch of a provider file; GitHub raw
fetches through the tool render as an AI-summarized excerpt, not verbatim source, so treat the
below as directionally-accurate, not verbatim-quoted code).

Its Codex writer path corroborates the core `session_meta` shape we found independently
(`id`, `session_id`, `cwd`, `timestamp`, `originator`, `cli_version`, `source`, `thread_source`,
`model_provider`) and confirms `response_item` uses `output_text`/`input_text` content blocks
keyed on role. It diverges from our verified-safe approach in two ways worth flagging as
**unverified-against-live-Codex** if turnbridge borrows from it directly:
1. It emits some user messages as `event_msg` (`user_message`/`agent_reasoning`) instead of
   `response_item` — per our findings, `event_msg` is NOT required for context replay and,
   more importantly, we have no evidence it's *sufficient* on its own (we never tested a
   session containing only `event_msg` turns and no `response_item` turns) — likely a
   **combined-source strategy** (both possibly for TUI display fidelity + the actual
   `response_item` in a separate line), not a substitute for `response_item`.
2. It appears to place `tool_use`/`tool_result`-shaped blocks directly inside `message.content`,
   which — per §5 — we did not observe in any real Codex output and recommend avoiding in favor
   of plain-text folding, which is verified to work.

---

## 8. Unknowns / risks for the implementer

1. **Version drift**: this spec is pinned to codex-cli 0.144.6. Codex's rollout schema has
   clearly evolved rapidly (multi-agent fields, `custom_tool_call`, `world_state`, `compacted`
   are all plausibly recent additions) — treat this format as internal/unstable, not a public
   API. Re-verify against the installed `codex --version` before relying on this in production;
   the minimal schema in §3 is the safest bet for forward/backward compatibility since it's the
   smallest surface area.
2. **`function_call` replay safety — RESOLVED, safe** (probe, 2026-07-27, codex-cli 0.145.0,
   `scripts/probe-codex-function-call.mjs`). A well-formed `function_call` +
   `function_call_output` pair whose `name` is a tool Codex has never registered (`Edit`, a
   Claude tool) replays with no API rejection, and the resumed model correctly names the tool it
   sees. The feared foreign-name/`call_id` validation failure did not occur. Verified end to end
   through turnbridge's own `fabricate()`, not just hand-written files, so §5's
   text-folding recommendation is superseded for *paired* calls — see §5.1.
   An orphaned `function_call_output` also does not error, but it carries no `name` at all, so
   the tool's identity is lost; unpaired results therefore stay text-folded.
   **`custom_tool_call` remains unverified** and is still not fabricated.
3. **Picker/`--all` cwd-filtering exact matching logic** (prefix? exact string? normalized path?)
   was not tested beyond reading the `--help` text; only direct `resume <id>` was verified.
4. **Very large fabricated histories — verified clean to 300 turns / ~217 KB** (probe,
   2026-07-27, codex-cli 0.145.0, `scripts/probe-large-history.mjs`). A fabricated 300-turn
   rollout resumed in ~5s with markers planted in both the first and last turns recalled: no
   size limit, no rejection, and no evidence of early history being dropped on load. Automatic
   `compacted` triggering was not observed at this size.
   **Beyond ~300 turns is deliberately unmeasured** — turnbridge passes history through
   untruncated and leaves fitting it to Codex's own compaction. Re-run with `PROBE_TURNS=N` to
   push the ceiling.
5. **`base_instructions`**: real files carry a large (~18KB) system prompt string per session.
   Omitting it entirely worked in our test (Codex presumably falls back to its own current
   default system prompt for the *new* turn, while the fabricated *history* turns are still
   replayed as-is) — but this means the fabricated session's replayed history won't perfectly
   match "what system prompt was actually active" if that matters for turnbridge's use case.
   Not a blocker for the stated goal (make prior context visible), just noted for completeness.
6. **`encrypted_content` for `reasoning` items**: confirmed unfabricatable and confirmed safe to
   omit outright (don't emit `reasoning` response_items at all rather than trying to synthesize
   fake ciphertext, which would almost certainly be rejected or ignored as garbage by the API if
   it were even parsed — untested, but omission is the verified-safe path).
7. **Interactive TUI resume** was only verified to "not error and begin rendering" via a pty
   wrapper (`script`); we could not capture/assert on the actual rendered TUI content
   programmatically. `codex exec resume --json` is the fully-verified, content-confirmed path
   and should be turnbridge's primary target/test surface; treat TUI-resume compatibility as
   "very likely fine, same underlying loader" rather than independently proven line-for-line.

---

## 9. Verification experiment log (for reproducibility)

1. Created scratch git repo at a scratchpad path, one commit.
2. Generated a UUIDv7 id, wrote a 3-line minimal `session_meta` + user `message` + assistant
   `message` file to `~/.codex/sessions/2026/07/18/rollout-<local-ts>-<uuid>.jsonl` (planted
   fact: "secret code word is BANANA77").
3. Ran `codex exec resume <id> "Reply with exactly the secret code word..." --json
   --skip-git-repo-check` from the scratch cwd → model correctly answered `BANANA77`.
4. Stripped the schema further (removed `session_id`, `source`, `thread_source`,
   `model_provider`, `history_mode`, `context_window`; kept only `id`, `timestamp`, `cwd`,
   `originator`, `cli_version`) with a new planted fact `PLUMFISH42` → still worked, from the
   scratch cwd.
5. Re-ran the same resume from `/tmp` (different cwd than fabricated `session_meta.cwd`) →
   still worked, proving direct-id resume ignores cwd matching.
6. Asked the resumed agent to run `pwd` (with `--dangerously-bypass-approvals-and-sandbox`) →
   printed `/tmp` (the real invocation cwd), confirming `session_meta.cwd` is not authoritative
   for execution root.
7. Regenerated with a plain `uuid4()` (non-time-ordered) id → still worked.
8. Tested interactive `codex resume <id>` with stdin redirected from `/dev/null` → immediate
   `Error: stdin is not a terminal` (no tty). Re-tested wrapped in macOS `script -q` to allocate
   a pty → process started emitting terminal-capability query escape sequences (bracketed paste
   mode, cursor position query, etc.), i.e. began normal TUI startup rather than erroring on the
   fabricated file; killed the backgrounded process after a few seconds (interactive rendering
   isn't scriptably assertable, but no crash/parse-error occurred).
9. Deleted all fabricated files/dirs after each test; verified the real
   `~/.codex/sessions/2026/07/18/` directory still contains exactly its original 22 files and
   no fabricated content remains anywhere under `~/.codex/sessions/` (`grep -rl` for planted
   secrets found nothing).

No real session files were read destructively, modified, or deleted at any point.
