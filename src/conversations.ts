import { readEvents, sortEvents, type EvidenceEvent, type RepoInfo } from "conversation-ledger";
import { turnContent, type ConversationSummary } from "./types.js";

export interface ListOptions {
  /** Include conversations from all authors, not just `user` / unowned. */
  all?: boolean;
  /** The current user's identity (git email) for ownership filtering. */
  user?: string | undefined;
  /** List conversations from all anchors, not just those reachable from HEAD. */
  anyCommit?: boolean;
}

/** Human-typed text, as opposed to CLI-injected wrappers like <command-name>. */
function meaningfulText(text: string): string | null {
  const t = text.trim();
  if (!t || t.startsWith("<")) return null;
  return t;
}

function deriveTitle(events: EvidenceEvent[]): string {
  for (const event of events) {
    if (event.actor.type !== "human") continue;
    const content = turnContent(event);
    if (!content || content.role !== "user") continue;
    for (const block of content.blocks) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      const t = meaningfulText(block.text);
      if (!t) continue;
      const oneLine = t.replace(/\s+/g, " ");
      return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
    }
  }
  return "(no visible user message)";
}

export async function listConversations(
  repo: RepoInfo,
  opts: ListOptions = {},
): Promise<ConversationSummary[]> {
  const events = await readEvents(repo, {
    kind: "conversation_turn",
    ...(opts.anyCommit ? {} : { reachableFrom: "HEAD" }),
  });

  const groups = new Map<string, EvidenceEvent[]>();
  for (const event of events) {
    if (!event.conversation?.id) continue;
    const group = groups.get(event.conversation.id);
    if (group) group.push(event);
    else groups.set(event.conversation.id, [event]);
  }

  const summaries: ConversationSummary[] = [];
  for (const [id, group] of groups) {
    const sorted = sortEvents(group);
    const owners = new Set<string>();
    const ownerDisplays = new Set<string>();
    for (const event of sorted) {
      if (event.actor.type === "human") {
        if (event.actor.id) owners.add(event.actor.id);
        if (event.actor.display) ownerDisplays.add(event.actor.display);
      }
    }
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const source = first.producer.source ?? id.split(":")[0] ?? "unknown";
    const sessionId = first.producer.session_id ?? id.split(":").slice(1).join(":");
    summaries.push({
      id,
      source,
      sessionId,
      title: deriveTitle(sorted),
      firstActivity: first.occurred_at,
      lastActivity: last.occurred_at,
      turnCount: sorted.length,
      owners: [...owners],
      ownerDisplays: [...ownerDisplays],
      events: sorted,
    });
  }

  const visible = summaries.filter((s) => {
    if (opts.all) return true;
    // Unowned conversations predate identity stamping; keep them visible.
    if (s.owners.length === 0) return true;
    return opts.user ? s.owners.includes(opts.user) : true;
  });

  visible.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return visible;
}
