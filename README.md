# Turnbridge

Lossless visible-conversation continuity between coding agent CLIs.

[Conversation Ledger](https://github.com/evintunador/conversation-ledger)
captures native local transcripts (Claude Code, Codex) incrementally into git
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
turnbridge list              # print compatible conversations

# options
#   --all                   include collaborators' conversations
#   --any-commit            include conversations from other branches/commits
#   --bootstrap             force transcript rehydration instead of native fabrication
#   --no-reasoning-replay   don't replay Codex-origin encrypted reasoning blobs

# optional: make bare `claude --resume` / `codex resume` open the merged picker
turnbridge shim install
```

Same-CLI selections use the CLI's native resume. Cross-CLI selections write a
target-native session file and hand off to the target's own resume; when that
is unsupported for the installed CLI version, turnbridge falls back to a fresh
session bootstrapped with the literal transcript.

opencode is currently a **target only**: turnbridge can bridge a Claude Code or
Codex conversation *into* it, but capturing conversations *out* of opencode
needs conversation-ledger's opencode adapter, which is a separate package. Its
sessions also live in one shared SQLite DB rather than per-session files, so
fabrication goes through `opencode import` — the only affordance that matters
in practice is that a bridged session is filed under the current directory's
opencode project, and `turnbridge shim install` writes no opencode shim
(opencode has no bare "open my sessions" command to intercept).

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

See [product intent](docs/PRODUCT_INTENT.md) and the [WIP technical design](docs/WIP_TECHNICAL_DESIGN.md).

## Development

```sh
npm install   # links ../conversation-ledger
npm test      # build + node --test
```

## License

[MIT](LICENSE)
