# Turnbridge

Lossless visible-conversation continuity between coding agent CLIs.

[Conversation Ledger](https://github.com/evintunador/conversation-ledger)
captures native local transcripts across its twenty-CLI roster incrementally into git
notes. Turnbridge is the resume layer on top: one picker across CLIs, honest
session typing, and rehydration of a conversation into a *different* CLI —
without claiming to transfer hidden reasoning or provider-private state, except
where it's verifiably real: a Codex-origin conversation fabricated back into
Codex replays its provider-encrypted reasoning blobs verbatim by default (see
"Encrypted reasoning replay" below), and the imported-session notice discloses
exactly that whenever it happens.

## Usage

```sh
# capture (once per machine): conversation-ledger hooks
cledger install all

# pick a conversation from this repo's history and resume it anywhere
turnbridge resume            # interactive: choose conversation, then target CLI
turnbridge resume codex      # resume straight into Codex
turnbridge resume claude     # resume straight into Claude Code
turnbridge resume opencode   # resume straight into opencode
turnbridge resume qwen       # native visible-text import where format supported
turnbridge resume gemini     # transcript bootstrap
turnbridge targets           # list implemented routes for all twenty targets
turnbridge list              # print compatible conversations
turnbridge records --help    # shared cledger records maintenance commands

# options
#   --all                   include collaborators' conversations
#   --any-commit            include conversations from other branches/commits
#   --bootstrap             force transcript rehydration instead of native fabrication
#   --no-reasoning-replay   don't replay Codex-origin encrypted reasoning blobs

# optional: make bare `claude --resume` / `codex resume` open the merged picker
turnbridge shim install
```

`turnbridge records <command>` operates on the **shared cledger conversation
records** at `refs/notes/conversation-ledger`, including turnbridge's
continuation events. It uses cledger's exact Ledger factory; turnbridge has no
separate notes ref, profile, transport hook, or `transport-push` entrypoint.
`cledger` owns capture, hook installation (`cledger install all`), and notes
transport. For example, `turnbridge records sync --fetch-only` fetches the
shared records. `turnbridge records review`, `inspect`, `redact`, `allow`, and
manual `reanchor` are human-only operations; run them yourself in a plain
terminal. `turnbridge sync`, `review`, `inspect`, `redact`, `allow`, and
`reanchor` are shortcuts to the same records dispatcher.

For standalone annals maintenance, register cledger's existing namespace once:

```sh
annals profile add conversation-ledger \
  --namespace conversation-ledger \
  --incoming cledger-incoming \
  --internal-env CLEDGER_INTERNAL \
  --state-dir conversation-ledger \
  --config-file .cledger.json \
  --user-config-dir cledger \
  --cli-name cledger
```

Same-CLI selections use exact native resume when implemented; Aider and Continue use transcript bootstrap because their current adapters cannot select an exact native session ID. Cross-CLI selections write a
target-native session file and hand off to the target's own resume; when that
is unsupported for the installed CLI version, turnbridge falls back to a fresh
session bootstrapped with the literal transcript.

opencode works in both directions as of conversation-ledger 0.18.0, which
captures it via a `session.idle` plugin rather than a shell hook. Two things
differ from the other CLIs in practice. Its sessions live in one shared SQLite
DB rather than per-session files, so fabrication goes through `opencode
import`, and a bridged session is filed under the current directory's opencode
project (turnbridge looks that up; if the directory isn't a registered opencode
project the session lands in the `global` one and is listed everywhere). And
`turnbridge shim install` writes no opencode shim — opencode has no bare
"open my sessions" command to intercept, since `-s` always takes an id.

## Encrypted reasoning replay

Codex's `reasoning` response_items carry ciphertext only OpenAI's servers can
decrypt; conversation-ledger preserves it losslessly and opaquely (0.10.0+).
When fabricating a Codex-origin conversation back into Codex, turnbridge
replays those blobs verbatim by default, which can restore hidden reasoning
provider-side (verified same-account and cross-account: see
conversation-ledger's roadmap). Replay is gated per-event on the reasoning
event's own `producer.source === "codex"`, so it can never apply to a
Claude Code target — foreign reasoning can't be forged as a native reasoning
item, so the only real switch is whether provider-matched replay happens.
The fabricated session's import notice discloses how many blocks were
replayed; the rest of the conversation is still the literal folded-text
transcript, same as always.

Opt out with `--no-reasoning-replay`, or persistently via
`{"reasoningReplay": false}` in `~/.turnbridge/config.json`.

See [product intent](docs/PRODUCT_INTENT.md), the
[roadmap](docs/ROADMAP.md), and the
[WIP technical design](docs/WIP_TECHNICAL_DESIGN.md).

## Development

```sh
npm install   # links ../conversation-ledger
npm test      # build + node --test
npm run verify:plan # planned installed-TUI hub matrix (does not launch CLIs)
```

The [CLI integration program](docs/CLI_INTEGRATION_PROGRAM.md) documents the
implemented twenty-target roster, exact-version evidence and known limitations.
Claude, Codex, OpenCode, Pi, Qwen, Goose and Kilo have native import writers; every
roster target has a transcript bootstrap route. Implemented syntax is distinct
from installed certification: authentication blockers, native runtime failures,
and untested versions remain visible in the reports.

```sh
npm run verify:installed -- --cledger /clean/cledger/dist/cli.js --only codex,opencode --mode native-import --output /tmp/tb-evidence
npm run verify:program -- --cledger /clean/cledger/dist/cli.js --runtime-dir /tmp/pinned-clis --output /tmp/tb-matrix
npm run verify:report -- /tmp/tb-matrix/evidence.json
```

Tests use disposable profiles, a bounded local scripted provider, real installed
CLIs and actual PTYs. They retain terminal traces, reconstructed SVG screens,
provider requests and automatically captured records; they never backfill a
failed capture to obtain a pass. Hub campaigns exercise both directions through
Claude/Codex/OpenCode on macOS and Linux. Scheduled candidate reviews create
draft evidence proposals without promoting pins or merging automatically.

For a contributor's local model, pass `--local-model config.json` to
`verify:installed`. The JSON must specify a loopback `endpoint` (server root),
`model`, and `protocol` (`messages`, `responses`, `chat-completions` or `gemini`).
Optional `maxRequests`, `maxOutputTokens` and `timeoutMs` bound the canary.
Each CLI keeps its native protocol; incompatible configurations fail explicitly.
Paid canaries require `--provider-config` with `tier: "usual-provider"`, HTTPS
endpoint, protocol/model, `budgetUsd`, explicit `inputUsdPerMillionTokens` and
`outputUsdPerMillionTokens`, and `apiKeyEnv: "TURNBRIDGE_VERIFY_PROVIDER_API_KEY"`.
Set that dedicated environment variable yourself; ordinary account credentials
are never inherited. Requests reserve a conservative text/token estimate before
inference and reject multimodal inputs. Supplied prices determine the estimate;
it is not a vendor billing guarantee. Paid and local-model evidence remain
separate from scripted passes. Neither live tier has been certified in this run.
Full visual layout judging remains separate work.

## License

[MIT](LICENSE)
