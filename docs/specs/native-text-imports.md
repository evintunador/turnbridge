# Native visible-text imports

Pi, Qwen and Goose intentionally represent foreign tool calls, results, visible
thinking and attachment references as labeled text. They retain visible content
without forging provider signatures or executable foreign function calls.

| Target | Format boundary | Entry point |
|---|---|---|
| Pi | 0.87.x; version 3 header, linked message IDs, assistant API/provider/usage envelope | `pi --session FILE` |
| Qwen | 0.24.x; project-scoped JSONL, user/model parts and UUID parent chain | `qwen --resume ID` |
| Goose | 1.52.x; Goose's public Pi JSONL converter owns database insertion | `goose session import FILE`, then exact-ID resume with history |
| Kilo | 7.8.x; OpenCode-compatible native import payload | `kilo import FILE`, then `kilo -s ID` |

Unknown format versions fall back to transcript bootstrap. These historical
format boundaries do not certify every patch release or operating system. The
installed reports record exact versions, mode, OS and provider tier separately.

Codex captures function arguments as JSON text. Claude, Codex, OpenCode and Kilo
writers decode JSON objects before constructing their native envelopes, avoiding
double encoding or OpenCode's `Expected object` rejection. Invalid raw values
remain labeled values. System tool-result turns stay user-side in Claude's format.

Provider `developer` instructions are retained in cledger's original records but
excluded from visible-history replay. Gemini's `model` and native `tool` aliases
normalize to assistant and tool-result roles; Copilot's omitted role is inferred
from the conversation actor. Non-turn records never become visible turns.

Bootstrap transcripts are immutable private files in per-launch directories.
Gemini/Qwen get the transcript directory through `--include-directories`;
Copilot uses `--add-dir`. Trust and permissions remain native user decisions.
Tests explicitly trust only disposable synthetic directories.

Rendered-history checks can inspect native viewing controls, rather than failing
merely because a tool card starts collapsed. Claude provides its
[transcript viewer](https://code.claude.com/docs/en/interactive-mode#transcript-viewer);
OpenCode exposes [tool detail and output keybindings](https://opencode.ai/docs/keybinds/).
Test-only bindings and observed marker frames are retained as evidence. A screen
layout certificate, attachment byte transfer and live-provider compatibility are
separate claims.

Qwen project directory names use `sanitizeCwd`: every character outside ASCII
letters and digits becomes a hyphen (including underscores, spaces, periods and
Unicode). This was checked against the installed 0.24.6 implementation and an
actual import/resume under such a path; replacing only path separators fails on
GitHub runner directories.
