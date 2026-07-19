import type { EvidenceEvent } from "conversation-ledger";
import { cliLabel, turnContent, type ConversationSummary, type TurnBlock } from "./types.js";

function blockToMarkdown(block: TurnBlock): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
      // visible thinking is part of the record but clearly labeled
      return block.text ? `> [thinking]\n> ${String(block.text).split("\n").join("\n> ")}` : "";
    case "tool_use":
      return [
        `**Tool call:** \`${block.name ?? "unknown"}\``,
        "```json",
        JSON.stringify(block.input ?? {}, null, 2),
        "```",
      ].join("\n");
    case "tool_result": {
      const body =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "", null, 2);
      return ["**Tool result:**", "```", body, "```"].join("\n");
    }
    default:
      return "```json\n" + JSON.stringify(block, null, 2) + "\n```";
  }
}

function roleHeading(event: EvidenceEvent, role: string): string {
  if (event.actor.type === "human") {
    return `## User${event.actor.display ? ` (${event.actor.display})` : ""}`;
  }
  if (role === "tool_result") return "## Tool result";
  return `## Assistant${event.actor.id ? ` (${event.actor.id})` : ""}`;
}

/**
 * Render a conversation as faithful markdown: literal content, no summarizing.
 * Used by the bootstrap rehydration path and for human inspection.
 */
export function renderTranscript(summary: ConversationSummary): string {
  const lines: string[] = [
    `# Conversation imported from ${cliLabel(summary.source)}`,
    "",
    `- Source session: \`${summary.sessionId}\``,
    `- Captured turns: ${summary.turnCount}`,
    `- First activity: ${summary.firstActivity}`,
    `- Last activity: ${summary.lastActivity}`,
    "",
  ];
  for (const event of summary.events) {
    const content = turnContent(event);
    if (!content) continue;
    const parts = content.blocks.map(blockToMarkdown).filter((p) => p.trim());
    if (parts.length === 0) continue;
    lines.push(roleHeading(event, content.role), "", ...parts, "");
  }
  return lines.join("\n");
}

/** Rough context-size estimate for pre-launch warnings. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
