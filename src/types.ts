import type { EvidenceEvent } from "conversation-ledger";

/** Canonical names for supported CLIs, matching cledger's `producer.source`. */
export type CliName = "claude-code" | "codex" | "opencode";

export const SUPPORTED_CLIS: CliName[] = ["claude-code", "codex", "opencode"];

/** Normalize user-typed CLI names (`claude`, `claude-code`, `codex`, `opencode`). */
export function parseCliName(input: string): CliName | null {
  const s = input.trim().toLowerCase();
  if (s === "claude" || s === "claude-code" || s === "claude_code") return "claude-code";
  if (s === "codex") return "codex";
  if (s === "opencode" || s === "open_code") return "opencode";
  return null;
}

export function cliLabel(name: string): string {
  if (name === "claude-code") return "Claude Code";
  if (name === "codex") return "Codex";
  if (name === "opencode") return "OpenCode";
  return name;
}

/** A conversation reconstructed from ledger events, ready for listing/resume. */
export interface ConversationSummary {
  /** Namespaced ledger id, e.g. `claude-code:<session-uuid>`. */
  id: string;
  /** Originating CLI (`producer.source`). */
  source: string;
  /** Native session id in the source CLI. */
  sessionId: string;
  /** First meaningful human message, truncated for display. */
  title: string;
  firstActivity: string;
  lastActivity: string;
  turnCount: number;
  /** Distinct human actor ids (git emails); empty when captured pre-identity. */
  owners: string[];
  ownerDisplays: string[];
  /**
   * All turn events plus opaque `reasoning` events, in canonical order.
   * `turnContent` returns null for `reasoning` events, so consumers that
   * only render visible content already skip them without change; targets
   * that replay them (currently only Codex-origin -> Codex) check
   * `event.kind === "reasoning"` explicitly.
   */
  events: EvidenceEvent[];
}

/** One normalized content block inside a turn (subset turnbridge consumes). */
export interface TurnBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface TurnContent {
  role: string;
  blocks: TurnBlock[];
}

/** Parse a ledger `conversation_turn` content payload; null when malformed. */
export function turnContent(event: EvidenceEvent): TurnContent | null {
  const c = event.content as { role?: unknown; blocks?: unknown } | null;
  if (!c || typeof c !== "object") return null;
  if (typeof c.role !== "string" || !Array.isArray(c.blocks)) return null;
  return { role: c.role, blocks: c.blocks as TurnBlock[] };
}
