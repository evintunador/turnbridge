# Initial local installed verification (macOS, 2026-10-06)

These are scripted-provider observations against installed binaries, not live
model certification. Capture used clean merged cledger `f9853f7`; the hosted
workflow also checks out the entire library dependency at that revision.
A final local hub rerun used clean copies of both cledger and annals
(`dcd06c0`), avoiding both dirty sibling working trees. Fresh captures and all
twelve directed hub/mode scenarios passed, as did all 141 unit/integration tests.

- The full unit/integration suite passes 141 tests with zero skips, including
  real terminal keyboard negotiation and user input cancelling delayed submission.
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
  isolated scripted authentication route. Codex→Kilo native import passed once,
  but Kilo 7.8.1 also crashed in its native Bun runtime during import/resume;
  the individual reports preserve those differing observations.
- Some native routes from previously bootstrapped captures initially failed
  history visibility because their tool cards start collapsed. Those failures
  remain failures; a bootstrap result does not substitute for native rendering.

The broader runs found and corrected test-provider tool-ID collisions, ranged
Copilot reads, Codex JSON-string tool inputs, split UTF-8 decoding, premature
composer submission, SessionEnd capture timing and mutable seed conversations.
Source snapshots now retain full ledger ancestry and select their source by
exact ID. Provider developer instructions are excluded from visible replay.

The complete local Codex campaign finished on October 7. Actual captured sources
passed both native import and bootstrap into Codex from Claude, Gemini, Copilot,
Qwen, Kimi, Vibe, OpenCode, Pi, OpenHands, Cline, Interpreter, Goose, Aider,
Continue, Crush and Kilo. Codex→Claude, Qwen and Pi passed both modes; its other
successful outbound routes include native Goose/OpenCode/Kilo and bootstrap
Copilot, Vibe, OpenHands, Cline and Crush. Follow-up tests corrected and passed
Codex→Gemini/Kimi/Interpreter/Goose/Kilo bootstrap and OpenCode native viewing. Every
pass includes the actual second native resume; Aider/Continue remain usable
sources without being certified as exact-ID-resumable targets.

The hosted OS campaigns publish authoritative exact-version
JSON reports, raw terminal traces, reconstructed screens, rendered marker frames,
provider requests and automatic ledger records are retained in task-owned temp
roots and in hosted CI artifacts. The complete 432-cell matrix includes missing,
failed, blocked and unsupported observations; this summary does not claim every
route or Linux is verified. Reconstructed screens received visual inspection;
full layout certification remains deferred. Live local and paid provider tiers
have configuration and budget guards but have not been executed in this run.

Hosted partial results exposed Qwen project-path encoding for underscores and
punctuation. An installed regression run under a matching path passed after
using Qwen's native sanitizer. Gemini resume waits for the restored composer,
and Claude native verification opens its transcript viewer for longer history.
The corresponding installed regressions passed locally.

The first complete hosted run passed five of six strict hub jobs. Its remaining
OpenCode model-discovery failure is retained in the artifacts. Isolated fixtures
disable remote catalog/plugin discovery for reproducibility; this does not
establish the cause of that intermittent failure.
The run also exposed epoch-dated Continue turns: only the synthetic import
notice is clamped to zero, preserving all real event timestamps. A real installed
Continue→OpenCode native regression passed. A Crush terminal-discovery reply
previously cancelled delayed Enter; both the nested PTY regression and an
installed OpenCode→Crush bootstrap/resume regression passed after correction.
Final both-OS evidence is reported with the draft PR’s installed checks.

Screen reconstruction samples rendered lines before destructive terminal updates,
retaining answers that are cleared during normal exit within the same PTY read.
A regression checks that behavior, and the retained Crush transcript was visually
inspected with the imported transcript read, fresh file result and answer visible.

Gemini 0.61.0 now has a native visible-text writer. Actual Claude, Codex and
OpenCode source captures passed every native continuation gate into Gemini,
including exact-ID resume; Claude/OpenCode regressions used project paths with
spaces, underscores and punctuation. Project registration uses the public CLI
without modifying its registry. The full hosted run includes this eighth writer.

An actual Codex→Gemini→Goose native chain passed every gate. The analogous
Qwen chain passed continuation but initially failed standard-mode history
viewing; the actual interactive screen-reader variant passed all gates. Source
and target UI modes are recorded separately so the variant cannot replace that
standard-mode failure. Qwen bootstrap plus exact native resume passed in the
explicit accessibility mode too.

A Linux Claude bootstrap failure exposed an exit/capture deadlock when native
SessionEnd had not yet flushed the final read result. The corrected verifier
permits graceful exit after completed inference and the actual TUI answer, then
requires both linked read/result and visible assistant completion in the ledger.
A disposable installed-Claude regression retaining only the native SessionEnd
hook passed bootstrap, capture, lineage and second exact-ID resume without any
manual capture or backfill. That hook-phase fixture is explicitly excluded from
standard-configuration certification.

Claude’s native show-all transcript control passed a longer captured Gemini
history. Copilot continuation passed after final-answer readiness used the
reconstructed screen, retaining a nonce split across cursor-addressed updates.

Gemini→OpenCode passed every continuation gate using its public native `/export`
viewer with interactive `less`, then returning to its restored composer. This
`native-export` result remains separate from the default-scrolling failure.

Native signal termination now returns a failure exit code through both direct
handoff and the production terminal relay; real child-process/PTY regressions
verify this rather than allowing a crash to look like a successful handoff.

Separate candidate checks passed Pi 1.0.4 bootstrap, automatic capture and exact
resume, plus transfer of its captured source into Codex in both modes. Its
unverified native import format safely remains unsupported. Kilo 7.8.3 still
exhibited native runtime crashes. These candidate observations do not promote
the pinned versions.
