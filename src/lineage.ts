import { appendEvents, readEvents, type EvidenceEvent, type RepoInfo } from "conversation-ledger";

const CONTINUATION_KIND = "continuation";
const CONTINUES_REL = "continues";

export interface ContinuationRecord {
  /** Conversation that was bridged from (the ancestor). */
  source: string;
  /** Conversation the bridge created (the descendant tip). */
  target: string;
  /** Highest source seq copied into the target at bridge time. */
  importedThroughSeq: number;
  /** Target CLI the bridge fabricated into. */
  targetCli: string;
  occurredAt: string;
}

export interface Lineage {
  /** target conversation id -> its continuation record (one parent). */
  parentOf: Map<string, ContinuationRecord>;
  /** source conversation id -> continuation records that descend from it. */
  childrenOf: Map<string, ContinuationRecord[]>;
}

/**
 * Record that `target` was fabricated as a continuation of `source`. Stored as
 * a ledger event so the edge travels and syncs with the conversations it
 * links, using conversation-ledger's `links` extension point.
 */
export async function recordContinuation(
  repo: RepoInfo,
  rec: Omit<ContinuationRecord, "occurredAt"> & { version: string },
): Promise<void> {
  const occurredAt = new Date().toISOString();
  await appendEvents(repo, [
    {
      kind: CONTINUATION_KIND,
      occurred_at: occurredAt,
      actor: { type: "system", id: "turnbridge" },
      producer: { tool: "turnbridge", version: rec.version, source: rec.targetCli },
      // belongs to the target conversation so it rides along with it
      conversation: { id: rec.target, seq: 0 },
      links: [{ rel: CONTINUES_REL, target: rec.source }],
      content: {
        source_conversation: rec.source,
        target_conversation: rec.target,
        imported_through_seq: rec.importedThroughSeq,
        target_cli: rec.targetCli,
      },
    },
  ]);
}

function parseRecord(event: EvidenceEvent): ContinuationRecord | null {
  const c = event.content as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return null;
  const source = c["source_conversation"];
  const target = c["target_conversation"];
  if (typeof source !== "string" || typeof target !== "string") return null;
  return {
    source,
    target,
    importedThroughSeq: typeof c["imported_through_seq"] === "number" ? c["imported_through_seq"] : 0,
    targetCli: typeof c["target_cli"] === "string" ? c["target_cli"] : "unknown",
    occurredAt: event.occurred_at,
  };
}

export async function readLineage(repo: RepoInfo, anyCommit = false): Promise<Lineage> {
  const events = await readEvents(repo, {
    kind: CONTINUATION_KIND,
    ...(anyCommit ? {} : { reachableFrom: "HEAD" }),
  });
  const parentOf = new Map<string, ContinuationRecord>();
  const childrenOf = new Map<string, ContinuationRecord[]>();
  for (const event of events) {
    const rec = parseRecord(event);
    if (!rec) continue;
    parentOf.set(rec.target, rec);
    const list = childrenOf.get(rec.source);
    if (list) list.push(rec);
    else childrenOf.set(rec.source, [rec]);
  }
  return { parentOf, childrenOf };
}
