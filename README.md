# Turnbridge

Lossless visible-conversation continuity between coding agent CLIs.

[Conversation Ledger](https://github.com/evintunador/conversation-ledger)
captures native local transcripts (Claude Code, Codex) incrementally into git
notes. Turnbridge is the resume layer on top: one picker across CLIs, honest
session typing, and rehydration of a conversation into a *different* CLI —
without claiming to transfer hidden reasoning or provider-private state.

## Usage

```sh
# capture (once per machine): conversation-ledger hooks
cledger install all

# pick a conversation from this repo's history and resume it anywhere
turnbridge resume            # interactive: choose conversation, then target CLI
turnbridge resume codex      # resume straight into Codex
turnbridge resume claude     # resume straight into Claude Code
turnbridge list              # print compatible conversations

# options
#   --all         include collaborators' conversations
#   --any-commit  include conversations from other branches/commits
#   --bootstrap   force transcript rehydration instead of native fabrication

# optional: make bare `claude --resume` / `codex resume` open the merged picker
turnbridge shim install
```

Same-CLI selections use the CLI's native resume. Cross-CLI selections write a
target-native session file and hand off to the target's own resume; when that
is unsupported for the installed CLI version, turnbridge falls back to a fresh
session bootstrapped with the literal transcript.

See [product intent](docs/PRODUCT_INTENT.md) and the [WIP technical design](docs/WIP_TECHNICAL_DESIGN.md).

## Development

```sh
npm install   # links ../conversation-ledger
npm test      # build + node --test
```

## License

[MIT](LICENSE)
