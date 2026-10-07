# Initial local installed verification (macOS, 2026-10-06)

These are scripted-provider observations against installed binaries, not live
model certification. Capture used clean merged cledger `f9853f7`; the hosted
workflow also checks out the entire library dependency at that revision.

- The full unit/integration suite passes 125 tests with zero skips.
- Actual captured Pi 0.87.1 history completed native import, context, a new linked
  read/result, automatic capture, lineage, exact native resume and normal exit in
  Claude 2.1.284, Codex 0.159.0, OpenCode 1.18.33 and Goose 1.52.0. Pi→Codex and
  Pi→OpenCode also completed bootstrap continuation.
- Target smoke runs completed all bootstrap continuation gates in Claude,
  Codex, OpenCode, Gemini 0.61.0, Qwen 0.24.6, Copilot 1.0.89, Kimi 2.1.1,
  Vibe 2.25.8, Pi 0.87.1, OpenHands 1.16.0, Cline 3.0.65, Interpreter 0.0.45,
  Goose 1.52.0 and Crush 0.97.1. Native target smoke passed Pi and Qwen.
- The production terminal relay was exercised inside a real PTY with Kimi,
  Goose, Crush and Aider. Aider 0.86.2 completed its recorded native file read,
  model context, automatic capture, lineage and normal exit, but its adapter
  cannot select an exact native session ID. Continue 1.5.47 has the same exact-ID
  limitation; neither is certified for the full continuation contract.
- Disposable Droid profiles require account login. Cursor/Kiro lack a configured
  isolated scripted authentication route. Kilo 7.8.1 crashed in its native Bun
  runtime during import/resume; those observations are blocked.
- Some native routes from previously bootstrapped captures initially failed
  history visibility because their tool cards start collapsed. Those failures
  remain failures; a bootstrap result does not substitute for native rendering.

The broader runs found and corrected test-provider tool-ID collisions, ranged
Copilot reads, Codex JSON-string tool inputs, split UTF-8 decoding, premature
composer submission, SessionEnd capture timing and mutable seed conversations.
Source snapshots now retain full ledger ancestry and select their source by
exact ID. Provider developer instructions are excluded from visible replay.

Full hub campaigns are being rerun with these corrections. Their exact-version
JSON reports, raw terminal traces, reconstructed screens, rendered marker frames,
provider requests and automatic ledger records are retained in task-owned temp
roots and in hosted CI artifacts. The complete 432-cell matrix includes missing,
failed, blocked and unsupported observations; this summary does not claim every
route or Linux is verified. Reconstructed screens received visual inspection;
full layout certification remains deferred. Live local and paid provider tiers
have configuration and budget guards but have not been executed in this run.
