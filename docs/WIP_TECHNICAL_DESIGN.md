# WIP technical design

**Status:** exploratory; adapter feasibility must be validated per CLI.

## Main flow

1. A source adapter discovers and tails the CLI's local transcript/session
   artifacts without modifying them.
2. After each completed visible turn, it normalizes newly observed material and
   appends it to Conversation Ledger.
3. A unified picker lists conversations compatible with the current repository,
   branch, `HEAD`, and user-selected sharing mode.
4. Native records for the selected CLI use its normal resume command. Imported
   records start a fresh target session and provide the complete canonical
   transcript as bootstrap context.

## Adapter contract

Each adapter must declare:

- transcript discovery and incremental cursor semantics;
- how it identifies completed versus partial turns;
- role/content/tool-call normalization rules;
- repository/session identity extraction;
- known omissions and safe failure behavior.

Adapters are readers first. Writing fabricated provider-native sessions may be
explored as an optional, version-pinned optimization but is not required for a
functional bridge and must never be the only recovery path.

The first Claude adapter should evaluate a pinned integration with an existing
local transcript extractor rather than reimplementing its format parser. The
wrapper still owns an incremental cursor and must tolerate schema changes and
incomplete final lines.

## Rehydration

The target adapter receives canonical events in order and constructs the
smallest supported bootstrap mechanism: an initial prompt, a local transcript
file plus an instruction to read it, or another documented import surface.
The UI must say that the target is a new rehydrated session. It must preserve
literal content, avoid silently summarizing, and report context-size limits
before launch.

## CLI UX proposal

An executable shim may intercept familiar forms such as `claude --resume` and
offer a merged picker. Selecting a native Claude conversation delegates to
Claude. Selecting a Codex-origin conversation launches Claude through the
rehydration path instead. Equivalent wrappers can serve other supported CLIs.

Default listings show only the current user's records that are compatible with
the checked-out code. Future cross-user mode expands the list with clear author
and code-state labels.

## Risks

Native formats can change without notice; transcript content can include
secrets; full histories consume substantial context; terminal processes can
crash mid-turn. The MVP must retain raw incremental capture, present partial
capture honestly, and provide redaction/local-only controls before any
automatic sharing is enabled.
