# CLI expansion and installed TUI verification

Implementation began after cledger PR #26 merged at
`f9853f7b38ee1fefdb587748055a18e240efb48c`. PR #35's broader capture conformance
is useful follow-up evidence, not a prerequisite. Never depend on its unmerged
implementation or a contributor's dirty sibling checkout for release proof.

## Scope and acceptance

Follow cledger's market-relevant CLI roster, currently twenty products. A roster
entry has an implemented bootstrap route, but syntax alone is not installed
certification. Native import writers exist for Claude, Codex, OpenCode, Pi, Qwen, Gemini, Goose
and Kilo; exact-ID resume is unavailable in the Aider and Continue adapters.

Claude, Codex and OpenCode are the verification hubs. Test every other CLI both into and
out of each hub, plus hub-to-hub routes. Deduplication yields 108 directed routes,
216 OS-specific routes, and 432 native-import/bootstrap scenarios. Same-CLI
resume is tested within each scenario, rather than as a separate cross-CLI route.
Each native-import scenario may ultimately be unsupported; report that explicitly
rather than substituting a bootstrap pass.

Native import requires rendered history, outbound model context containing the
import, a successful new linked tool call/result, automatic cledger capture,
correct continuation lineage, subsequent native resume, and normal exit.
Bootstrap requires all continuation gates and clear disclosure that this is a
fresh session reading a transcript. It does not require native imported scrollback.
Bootstrap lineage uses a unique prompt token and correlates only an exact
captured human turn. Ambiguous tokens never select a newest session. Original
source history is included in subsequent bridges without replaying the bootstrap
instruction as a conversation turn.

Record exact source and target versions, OS, mode, timestamp, inference tier and
artifact references. A newer failure supersedes an older pass only in that exact
cell. Scripted-provider evidence never qualifies a local-model or usual-provider
cell. Missing authentication is blocked, with a reason; absent drivers are not-run.
The evidence validator checks report completeness, not the truth of driver assertions.

## Execution infrastructure

`npm run verify:plan` prints the matrix and required gates; it executes no CLIs.
Unobserved scenarios remain not-run. `src/verification/pty.ts` and `process.ts`
are attributed copies of the merged cledger MIT helpers, with bounded output,
deadlines and process-group cleanup. A public cledger testing entrypoint is not
currently exported. Keep this small copy pinned until a shared package/interface
exists; avoid imports into undocumented installed package internals.

`npm run verify:report -- evidence.json [...]` validates arrays of driver evidence
and prints the complete matrix with latest observations per exact version/tier.
Untested cells remain not-run; a scripted pass alongside a login-blocked provider
run remains two separate observations. Invalid pass claims fail the command.

Drivers must provision pinned real binaries, install cledger capture into
disposable profiles, and launch interactive sessions on macOS and Linux. Never
inherit normal credentials, sessions or hooks. Build provider configuration
explicitly after creating the isolated environment. Use a scripted HTTP model
substitute in free CI; local canaries accept contributor-configured endpoint,
model and protocol instead of assuming DeepSeek. Paid checks remain a separate explicit tier with request/token bounds and an
estimated USD reservation using supplied prices. Dedicated credentials are held
only by the proxy, not inherited by native CLI children.

Raw PTY markers are partial rendering evidence. Full screen-layout evaluation,
including possible image-based checks, remains deferred. For now inspect markers,
tool rows, import disclosure and render failures; separately inspect outbound
provider requests and automatic ledger observations before any backfill.

## Implemented execution

1. Matrix, exact-version report validation and portable PTY isolation are implemented.
2. Installed scripted-provider drivers check continuation, tools, capture, lineage
   and native resume. `smoke:interactive` now uses disposable profiles, and the
   old script is a compatibility wrapper.
3. All twenty targets have bootstrap syntax. `turnbridge targets` separates native
   import, exact native resume and bootstrap. Pi/Qwen/Gemini fold foreign tools, visible
   thinking and attachment references into labeled text, preserving content without
   claiming executable native foreign calls.
4. `verify:program` creates real captured source snapshots, then exercises both
   directions and modes through each hub. Target smoke fixtures never become
   installed-source evidence. CI runs each hub on macOS and Linux, retaining
   all observations and the full matrix denominator.
5. Scheduled reviews on the first and fifteenth observe npm releases, provision
   exact candidates, run both-OS installed campaigns and prepare draft evidence
   proposals. They never promote pins automatically. Native/Python upgrades need
   separate checksum and lock review; paid-provider tests require explicit credentials and supplied budget/pricing.

Current adapters' broad validated version prefixes are historical format checks,
not exact-version installed certification. Do not widen them from capture-only
evidence. New structured verification must preserve that distinction.

## Running and interpreting evidence

`verify:installed -- --cledger PATH --only CLI,... --source CLI --mode MODE`
checks targets using a canonical source fixture. Add `--source-file` pointing to
a retained `source-snapshot.json` to establish a real installed-source bridge.
`verify:program` provisions source captures and runs the hub graph automatically;
`--hub` and `--only` bound a local campaign. `--sources FILE` supplies an explicit
CLI-to-source-snapshot mapping; those seeds remain immutable across the run. `--runtime-dir` loads the pinned npm
runtime manifest; native/Python binary overrides use `TURNBRIDGE_VERIFY_*_BINARY`
and Aider's interpreter uses `TURNBRIDGE_AIDER_PYTHON` (preserve its venv path).

Reports retain fail, blocked and unsupported results. Exploratory local runs succeed
only if they earn installed bridge passes. Hosted CI adds `--require-core true`,
requiring every selected hub-to-hub direction in both modes to pass; peripheral
routes retain their individual results. Neither rule claims every matrix cell
passes. Candidate promotion is a manual review of regressions and both-OS proof,
not a green workflow badge. A new CLI's bootstrap can be useful even when its
exact-ID resume prevents satisfying the full continuation certification.

The production PTY handoff is exercised inside the test PTY for targets without
an interactive prompt flag. Folder-trust input is forwarded before prompt
submission; Turnbridge waits for a real composer and an echoed prompt. It never
automatically accepts user trust/approval dialogs. Tests may accept only their
synthetic fixture folders and enable benign reads for the scripted provider.
Kilo's fixture sets [`snapshot: false`](https://kilo.ai/docs/code-with-ai/features/checkpoints)
because hosted resume can stall in snapshot initialization before inference.
Its reports explicitly exclude filesystem checkpoint/rollback behavior; normal
Turnbridge launches retain the contributor's own native configuration.

See the [initial macOS observations](verification-evidence/2026-10-06-macos-summary.md) for the current proof boundary.

Live canaries assemble visible assistant text across streaming token events before
checking completion. Hidden reasoning and tool-call arguments cannot satisfy that
check. Inference still requires an explicitly configured local endpoint or a
dedicated, budgeted provider configuration.

Qwen installed verification uses its native interactive `--screen-reader` mode
to expose older restored turns. Reports and source snapshots record source/target
UI modes; accessibility-mode passes cannot supersede standard-mode failures.
The standard visual Qwen layout remains outside that certificate.

Scheduled review proposals are also retained as thirty-day artifacts. If GitHub
blocks automatic draft creation, the workflow emits a warning and links reviewers
to that proposal rather than losing the evidence. The repository
[Actions creation/approval setting](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#preventing-github-actions-from-creating-or-approving-pull-requests)
is currently disabled; enabling that bundled permission requires owner approval.

Exit readiness uses completed inference and native rendered replies where the
driver supports them. Copilot replies are reconstructed from cursor updates;
OpenHands/Cline use completion signals rather than a rendered-answer gate.
Ledger proof is checked after normal native exit so SessionEnd capture can flush
the read result and final answer. The verifier never performs backfill; both
linked read/result and visible assistant completion remain mandatory gates.

Gemini→OpenCode native history is inspected through OpenCode’s public `/export`
action and the interactive `less` editor. Evidence calls this `native-export`,
separately from default-scroll failures. The exported content comes from the
installed CLI’s own session, never a verifier-printed ledger transcript.
