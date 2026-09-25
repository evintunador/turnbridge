# Roadmap

This is the durable home for project-wide follow-up work. Design rationale and
completed validation remain in the linked design/spec documents rather than
being repeated here.

## CLI coverage

- Verify bridging **out of** Gemini CLI and Qwen Code conversations captured by
  cledger, then document the supported behavior.
- Add Gemini CLI and Qwen Code target adapters so those CLIs can also be
  bridged **into**. Until then they may appear as source conversations but are
  intentionally one-way.
- Once every intended CLI has a target adapter, run a small credentialed
  support matrix against each provider and record the tested CLI versions.

## Adapter validation

- Add a headless model-recall probe for opencode, analogous to
  `scripts/probe-codex-content.mjs`.
- Measure opencode behavior with long imported histories.
- After the broader CLI support matrix is in place and Claude access is
  available, probe whether Claude Code's `system` or `attachment` transcript
  lines actually reach model context. If either is model-visible, use it for
  the import notice instead of representing the notice as a user turn. See
  [the Claude session-format spec](specs/claude-session-format.md).

## Release

- Publish `conversation-ledger` to npm, replace turnbridge's local `file:`
  dependency with a semver range, and then publish turnbridge. The
  `prepublishOnly` check deliberately blocks publishing before this is done.
- Re-run the interactive, recall, invariant, large-history, function-call, and
  picker probes against the release CLI versions. Adapter-drift automation
  remains reporting-only; credentialed validation is a human-run release task.

## Research backlog

These are non-blocking unknowns, not current release requirements:

- Codex encrypted-reasoning blob lifetime and API-platform-organization auth.
- Histories beyond roughly 300 turns and `custom_tool_call` fabrication.
- Claude Code's picker sort key.
- opencode's project-id derivation if a future release makes it relevant to
  import placement.

