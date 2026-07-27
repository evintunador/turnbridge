import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceEvent } from "conversation-ledger";
import { bootstrapPrompt } from "../bootstrap.js";
import { normalizeTimestamp } from "../timestamps.js";
import { formatSize, transcriptSize } from "../transcript.js";
import { binaryOnPath } from "../launch.js";
import { cliLabel, turnContent, type ConversationSummary, type TurnBlock } from "../types.js";
import { FabricationUnsupportedError, type LaunchPlan, type TargetAdapter } from "./types.js";

/**
 * Rollout writer validated against codex-cli 0.144.x and 0.145.x (2026-07):
 * resume-by-id scans ~/.codex/sessions for a rollout file whose name and
 * session_meta id match; plain `message` response_items are the replayed
 * conversation state. 0.145.0 revalidated 2026-07-21 via the interactive
 * smoke test plus a headless `codex exec resume` marker-recall probe
 * (scripts/probe-codex-content.mjs).
 */
const VALIDATED_VERSION_PREFIXES = ["0.144.", "0.145."];

function codexVersion(): string | null {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}

function sessionsDir(): string {
  const home = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  return join(home, "sessions");
}

/** Local-time filename stamp: YYYY-MM-DDTHH-MM-SS. */
function localStamp(d: Date): { datePath: string; stamp: string } {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const datePath = join(String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return { datePath, stamp };
}

/**
 * Fold any block into plain text. Only input_text/output_text message blocks
 * are validated to replay safely in Codex, so foreign tool calls become
 * labeled text rather than fabricated function_call records.
 */
function foldBlock(block: TurnBlock): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
      return block.text ? `[visible thinking]\n${String(block.text)}` : "";
    case "tool_use":
      return `[used tool: ${block.name ?? "unknown"}]\ninput: ${JSON.stringify(block.input ?? {})}`;
    case "tool_result": {
      const body =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      return `[tool result]\n${body}`;
    }
    default:
      return JSON.stringify(block);
  }
}

interface RolloutLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

function messageLine(timestamp: string, role: "user" | "assistant", text: string): RolloutLine {
  const blockType = role === "assistant" ? "output_text" : "input_text";
  return {
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: blockType, text }] },
  };
}

/**
 * TUI scrollback renders from event_msg records, not response_items; without
 * these the resumed session looks empty even though the model sees history.
 */
function displayLine(timestamp: string, role: "user" | "assistant", text: string): RolloutLine {
  const payload =
    role === "user"
      ? { type: "user_message", message: text, images: [], local_images: [], text_elements: [] }
      : { type: "agent_message", message: text, phase: "final_answer", memory_citation: null };
  return { timestamp, type: "event_msg", payload };
}

/** A conversation turn as both the model-context record and its display twin. */
function turnLines(timestamp: string, role: "user" | "assistant", text: string): RolloutLine[] {
  return role === "user"
    ? [displayLine(timestamp, role, text), messageLine(timestamp, role, text)]
    : [messageLine(timestamp, role, text), displayLine(timestamp, role, text)];
}

/**
 * `reasoning` events this fabrication should replay verbatim: opaque
 * `encrypted_content` only the originating provider can decrypt, which the
 * ledger preserves losslessly (raw.data holds the exact original
 * response_item line) but never interprets. Foreign reasoning cannot be
 * forged as a native reasoning item, so replay is gated per-event on
 * `producer.source === "codex"` — the only direction this can ever be
 * valid, regardless of how the rest of the conversation's lineage looks.
 */
function eligibleReasoning(summary: ConversationSummary, replayReasoning: boolean): EvidenceEvent[] {
  if (!replayReasoning) return [];
  return summary.events.filter((e) => e.kind === "reasoning" && e.producer.source === "codex");
}

/** The verbatim `{type: "response_item", payload: {type: "reasoning", ...}}` line, if shaped as expected. */
function reasoningRolloutLine(event: EvidenceEvent, now: Date): RolloutLine | null {
  const line = event.raw?.data as { type?: unknown; payload?: unknown } | undefined;
  if (line?.type !== "response_item" || !line.payload || typeof line.payload !== "object") return null;
  return {
    // Outer rollout field only — `payload` (where the ciphertext lives) stays
    // byte-identical, since that is what the provider has to be able to decrypt.
    timestamp: normalizeTimestamp(event.occurred_at, now),
    type: "response_item",
    payload: line.payload as Record<string, unknown>,
  };
}

export function buildRolloutLines(
  summary: ConversationSummary,
  sessionId: string,
  cwd: string,
  cliVersion: string,
  now: Date,
  replayReasoning = true,
): RolloutLine[] {
  const nowIso = now.toISOString();
  const replayCount = eligibleReasoning(summary, replayReasoning).length;
  const noticeText =
    replayCount > 0
      ? `[turnbridge import notice] This conversation was imported from ${cliLabel(summary.source)}. ` +
        `The history below is the literal visible transcript. ${replayCount} encrypted reasoning ` +
        "block(s) from the original Codex session were also replayed verbatim below, which may restore " +
        "hidden reasoning provider-side; all other hidden reasoning and provider-private state, and past " +
        "tool calls, were not transferred and are shown as labeled text, not replayable calls."
      : `[turnbridge import notice] This conversation was imported from ${cliLabel(summary.source)}. ` +
        "The history below is the literal visible transcript; hidden reasoning and provider-private " +
        "state were not transferred, and past tool calls are shown as labeled text, not replayable calls.";

  const lines: RolloutLine[] = [
    {
      timestamp: nowIso,
      type: "session_meta",
      payload: {
        session_id: sessionId,
        id: sessionId,
        timestamp: nowIso,
        cwd,
        originator: "codex-tui",
        cli_version: cliVersion,
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
        history_mode: "legacy",
      },
    },
    ...turnLines(nowIso, "user", noticeText),
  ];

  for (const event of summary.events) {
    if (event.kind === "reasoning") {
      if (!replayReasoning || event.producer.source !== "codex") continue;
      const line = reasoningRolloutLine(event, now);
      if (line) lines.push(line);
      continue;
    }
    const content = turnContent(event);
    if (!content) continue;
    const text = content.blocks.map(foldBlock).filter((t) => t.trim()).join("\n\n");
    if (!text) continue;
    const role = event.actor.type === "human" ? "user" : "assistant";
    lines.push(...turnLines(normalizeTimestamp(event.occurred_at, now), role, text));
  }
  return lines;
}

export const codexTarget: TargetAdapter = {
  name: "codex",
  binary: "codex",

  isInstalled() {
    return binaryOnPath("codex");
  },

  nativeResume(sessionId: string, cwd: string): LaunchPlan {
    return {
      command: "codex",
      args: ["resume", sessionId],
      cwd,
      notes: [`resuming native Codex session ${sessionId}`],
    };
  },

  async fabricate(
    summary: ConversationSummary,
    cwd: string,
    opts: { replayReasoning: boolean },
  ): Promise<LaunchPlan> {
    const version = codexVersion();
    if (!version) {
      throw new FabricationUnsupportedError("could not determine codex version", "codex");
    }
    const notes: string[] = [];
    if (!VALIDATED_VERSION_PREFIXES.some((p) => version.startsWith(p))) {
      notes.push(
        `codex ${version} has not been validated against the fabrication spec (validated: ${VALIDATED_VERSION_PREFIXES.map((p) => `${p}x`).join(", ")}); ` +
          "rerun with --bootstrap if the resumed session misbehaves",
      );
    }

    const sessionId = randomUUID();
    const now = new Date();
    const { datePath, stamp } = localStamp(now);
    const dir = join(sessionsDir(), datePath);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
    const lines = buildRolloutLines(summary, sessionId, cwd, version, now, opts.replayReasoning);
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await writeFile(path, body);

    notes.push(
      `fabricated Codex session ${sessionId} from ${cliLabel(summary.source)} history (${summary.turnCount} turns)`,
      `rollout file: ${path} (${formatSize(transcriptSize(body))})`,
    );
    const replayCount = eligibleReasoning(summary, opts.replayReasoning).length;
    if (replayCount > 0) {
      notes.push(
        `replayed ${replayCount} encrypted reasoning block(s) from the original Codex session verbatim ` +
          "(may restore hidden reasoning provider-side; disable with reasoningReplay: false in " +
          "~/.turnbridge/config.json or --no-reasoning-replay)",
      );
    }
    return {
      command: "codex",
      args: ["resume", sessionId],
      cwd,
      notes,
      fabricatedConversationId: `codex:${sessionId}`,
    };
  },

  bootstrap(summary: ConversationSummary, cwd: string, transcriptPath: string): LaunchPlan {
    return {
      command: "codex",
      args: [bootstrapPrompt(summary, transcriptPath)],
      cwd,
      notes: [
        `starting a NEW Codex session rehydrated from ${cliLabel(summary.source)} (bootstrap mode)`,
        `transcript: ${transcriptPath}`,
      ],
    };
  },
};
