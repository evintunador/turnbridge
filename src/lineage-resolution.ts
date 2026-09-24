import type { EvidenceEvent } from "conversation-ledger";
import type { Lineage, ContinuationRecord } from "./lineage.js";
import { turnContent, type ConversationSummary } from "./types.js";

export interface ResolvedHistory {
  summary: ConversationSummary;
  /** Human-facing degradation disclosures; never injected into model context. */
  notes: string[];
}

function atOrBefore(event: EvidenceEvent, iso: string): boolean {
  const eventTime = Date.parse(event.occurred_at);
  const boundary = Date.parse(iso);
  if (!Number.isNaN(eventTime) && !Number.isNaN(boundary)) return eventTime <= boundary;
  return false;
}

function isTurnbridgeNotice(event: EvidenceEvent): boolean {
  const content = turnContent(event);
  return Boolean(
    content?.blocks.some(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trimStart().startsWith("[turnbridge import notice]"),
    ),
  );
}

function sourceSeq(record: ContinuationRecord, event: EvidenceEvent): boolean {
  return (event.stream?.seq ?? Number.POSITIVE_INFINITY) <= record.importedThroughSeq;
}

/** Root-to-tip CLI path, with cycle protection for malformed lineage. */
function lineageSources(summary: ConversationSummary, lineage: Lineage): string[] {
  const reversed = [summary.source];
  const seen = new Set([summary.id]);
  let id = summary.id;
  while (true) {
    const parent = lineage.parentOf.get(id);
    if (!parent || seen.has(parent.source)) break;
    seen.add(parent.source);
    reversed.push(parent.source.split(":")[0] ?? parent.source);
    id = parent.source;
  }
  return reversed.reverse();
}

/**
 * Replace turnbridge-authored copies with the source events recorded in their
 * continuation edge. New records already contain flattened origin ids, so a
 * later hop reads each turn from where it originated rather than from the
 * preceding copy. Legacy records recurse through their source conversation.
 */
export function resolveLineageHistory(
  selected: ConversationSummary,
  available: ConversationSummary[],
  lineage: Lineage,
): ResolvedHistory {
  const byConversation = new Map(available.map((summary) => [summary.id, summary]));
  const byEvent = new Map<string, { event: EvidenceEvent; summary: ConversationSummary }>();
  for (const summary of available) {
    for (const event of summary.events) byEvent.set(event.id, { event, summary });
  }
  const notes = new Set<string>();
  const resolving = new Set<string>();

  const resolve = (summary: ConversationSummary, requested?: Set<string>): EvidenceEvent[] => {
    const selectedEvents = requested
      ? summary.events.filter((event) => requested.has(event.id))
      : summary.events;
    const parent = lineage.parentOf.get(summary.id);
    if (!parent) return selectedEvents;

    if (resolving.has(summary.id)) {
      notes.add(`lineage cycle detected at ${summary.id}; using the captured copy`);
      return selectedEvents.filter((event) => !isTurnbridgeNotice(event));
    }

    const copied = selectedEvents.filter((event) => atOrBefore(event, parent.occurredAt));
    const originatedHere = selectedEvents.filter((event) => !atOrBefore(event, parent.occurredAt));
    if (copied.length === 0) return originatedHere;

    resolving.add(summary.id);
    let origins: EvidenceEvent[] | null = null;

    const source = byConversation.get(parent.source);
    if (source) {
      // Resolve the whole source snapshot, not only events the intermediate
      // target could represent. That is what restores transport-dropped data
      // such as Codex reasoning when a later target can carry it again.
      const sourceIds = new Set(
        source.events.filter((event) => sourceSeq(parent, event)).map((event) => event.id),
      );
      origins = resolve(source, sourceIds);
    } else if (parent.sourceEventIds) {
      // Flattened origin ids still provide a precise fallback when the direct
      // source conversation itself is unreachable.
      const resolved = parent.sourceEventIds.map((id) => byEvent.get(id));
      if (resolved.every((entry) => entry !== undefined)) {
        origins = resolved
          .map((entry) => entry!)
          .filter(({ event, summary: owner }) => {
            const ownerParent = lineage.parentOf.get(owner.id);
            return !(
              ownerParent &&
              atOrBefore(event, ownerParent.occurredAt) &&
              isTurnbridgeNotice(event)
            );
          })
          .map(({ event }) => event);
      }
    }

    resolving.delete(summary.id);
    if (!origins) {
      notes.add(
        `original events for ${parent.source} are unavailable; using the captured copy in ${summary.id}`,
      );
      origins = copied.filter((event) => !isTurnbridgeNotice(event));
    }
    return [...origins, ...originatedHere];
  };

  const events = resolve(selected);
  const first = events[0];
  const last = events[events.length - 1];
  return {
    summary: {
      ...selected,
      ...(first ? { firstActivity: first.occurred_at } : {}),
      ...(last ? { lastActivity: last.occurred_at } : {}),
      turnCount: events.filter((event) => event.kind === "conversation_turn").length,
      events,
      lineageSources: lineageSources(selected, lineage),
    },
    notes: [...notes],
  };
}
