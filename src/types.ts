import type { EvidenceEvent } from "conversation-ledger";
import { CLI_CATALOG } from "./cli-catalog.js";

/** Canonical names for supported CLIs, matching cledger's `producer.source`. */
export type CliName = typeof CLI_CATALOG[number]["id"];

export const SUPPORTED_CLIS: CliName[] = CLI_CATALOG.map(cli => cli.id);

/** Normalize user-typed CLI names (`claude`, `claude-code`, `codex`, `opencode`). */
export function parseCliName(input: string): CliName | null {
  const s = input.trim().toLowerCase();
  const normalized = s.replaceAll("_", "-");
  const aliases: Record<string, CliName> = { claude: "claude-code", "open-code": "opencode", gemini: "gemini-cli", qwen: "qwen-code", agent: "cursor", vibe: "mistral-vibe", "kiro-cli": "kiro", interpreter: "open-interpreter", cn: "continue", kilocode: "kilo" };
  return aliases[normalized] ?? CLI_CATALOG.find(cli => cli.id === normalized)?.id ?? null;
}

export function cliLabel(name: string): string {
  return CLI_CATALOG.find(cli => cli.id === name)?.name ?? name;
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
  /** Root-to-selected CLI path when turnbridge reconstructed multi-hop history. */
  lineageSources?: string[];
  /** Unique pending-bootstrap correlation, set by the resume planner. */
  bootstrapToken?: string;
  /**
   * All turn events plus opaque `reasoning` events, in canonical order.
   * `turnContent` returns null for `reasoning` events, so consumers that
   * only render visible content already skip them without change; targets
   * that replay them (currently only Codex-origin -> Codex) check
   * `event.kind === "reasoning"` explicitly.
   */
  events: EvidenceEvent[];
}

/** Label used by the one import notice emitted for a reconstructed history. */
export function importSourceLabel(summary: ConversationSummary): string {
  const sources = summary.lineageSources ?? [summary.source];
  return sources.map(cliLabel).join(" → ");
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
  if (event.kind !== "conversation_turn") return null;
  const c = event.content as { role?: unknown; blocks?: unknown } | null;
  if (!c || typeof c !== "object") return null;
  if (!Array.isArray(c.blocks)) return null;
  let role = c.role;
  // Some native captures retain provider developer instructions as turns.
  // Those are not visible conversation history and must not become an
  // assistant message or instructions in a different CLI.
  if (role === "developer") return null;
  if (role === "model") role = "assistant";
  if (role === "tool") role = "tool_result";
  if (role === undefined && event.kind === "conversation_turn") {
    if (event.actor?.type === "human") role = "user";
    else if (event.actor?.type === "agent") role = "assistant";
    else if (event.actor?.type === "system") role = (c.blocks as TurnBlock[]).some(block => block.type === "tool_result") ? "tool_result" : "system";
  }
  return typeof role === "string" ? { role, blocks: c.blocks as TurnBlock[] } : null;
}
