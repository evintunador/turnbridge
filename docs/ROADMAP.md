# Roadmap

This is the durable home for project-wide follow-up work. Design rationale and
completed validation remain in the linked design/spec documents rather than
being repeated here.

## CLI coverage

- All twenty roster targets now have bootstrap adapters; Claude, Codex, OpenCode,
  Pi, Qwen, Goose and Kilo have native import writers. Continue expanding exact-version
  evidence through the [CLI integration program](CLI_INTEGRATION_PROGRAM.md).
- Resolve upstream authentication/runtime blockers and exact-ID resume limitations
  without hiding them in the matrix. Keep unsupported native imports separate
  from usable bootstrap paths.
- Run configured local-model canaries and explicitly bounded paid-provider checks
  after scripted installed coverage. Live provider canaries are configured explicitly and have not yet been run.
- Add screen layout evaluation beyond retained reconstructed terminal screens.

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
  picker probes against the release CLI versions. Scheduled candidate maintenance opens draft evidence proposals; runtime pins
  advance only after both-OS bridge evidence and maintainer review. Credentialed
  validation remains a separate release task.

## Research backlog

These are non-blocking unknowns, not current release requirements:

- Codex encrypted-reasoning blob lifetime and API-platform-organization auth.
- Histories beyond roughly 300 turns and `custom_tool_call` fabrication.
- Claude Code's picker sort key.
- opencode's project-id derivation if a future release makes it relevant to
  import placement.
