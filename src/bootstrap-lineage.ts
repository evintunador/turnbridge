import { appendEvents, readEvents, type EvidenceEvent, type RepoInfo } from "conversation-ledger";
import { recordContinuation, readLineage } from "./lineage.js";
import { turnContent } from "./types.js";

interface PendingBootstrap {
  token: string;
  source: string;
  targetCli: string;
  importedThroughSeq: number;
  sourceEventIds: string[];
  version: string;
}

export async function recordPendingBootstrap(repo: RepoInfo, pending: PendingBootstrap): Promise<void> {
  await appendEvents(repo, [{ kind: "bootstrap_continuation_pending", occurred_at: new Date().toISOString(),
    actor: { type: "system", id: "turnbridge" }, producer: { tool: "turnbridge", source: pending.targetCli, version: pending.version },
    content: { ...pending }, links: [{ rel: "continues", target: pending.source }] }]);
}

function pendingRecord(event: EvidenceEvent): PendingBootstrap | null {
  const c = event.content as Partial<PendingBootstrap> | null;
  if (!c || typeof c.token !== "string" || !/^[a-f0-9-]{36}$/.test(c.token) || typeof c.source !== "string" || typeof c.targetCli !== "string" || typeof c.version !== "string" ||
      typeof c.importedThroughSeq !== "number" || !Array.isArray(c.sourceEventIds) || !c.sourceEventIds.every(id => typeof id === "string")) return null;
  return c as PendingBootstrap;
}

/** Correlate only an exact unique token in a captured user turn; never latest-session guessing. */
export async function reconcileBootstrapContinuations(repo: RepoInfo): Promise<number> {
  const pending = await readEvents(repo, { kind: "bootstrap_continuation_pending", tool: "turnbridge" });
  if (!pending.length) return 0;
  const turns = await readEvents(repo, { kind: "conversation_turn" });
  const lineage = await readLineage(repo, true);
  let linked = 0;
  for (const event of pending) {
    const record = pendingRecord(event);
    if (!record) continue;
    const marker = `[turnbridge bootstrap ${record.token}]`;
    const matches = turns.filter(turn => turn.producer.source === record.targetCli && turn.actor.type === "human" && turn.stream?.id &&
      turnContent(turn)?.blocks.some(block => {
        if (block.type !== "text" || typeof block.text !== "string") return false;
        const text = turn.producer.source === "cline" ? block.text.replace(/^<user_input(?:\s[^>]*)?>\s*/, "") : block.text;
        return text.startsWith(marker);
      }));
    const sessions = new Set(matches.map(turn => turn.stream!.id));
    if (sessions.size !== 1) continue;
    const turn = matches[0]!, target = turn.stream!.id;
    if (lineage.parentOf.has(target) || target === record.source) continue;
    await recordContinuation(repo, { source: record.source, target, targetCli: record.targetCli,
      importedThroughSeq: record.importedThroughSeq, sourceEventIds: record.sourceEventIds,
      mode: "bootstrap", bootstrapPromptEventId: turn.id, version: record.version });
    lineage.parentOf.set(target, { source: record.source, target, targetCli: record.targetCli, importedThroughSeq: record.importedThroughSeq, occurredAt: new Date().toISOString() });
    linked++;
  }
  return linked;
}
