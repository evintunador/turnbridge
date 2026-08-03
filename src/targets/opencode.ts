import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeTimestamp } from "../timestamps.js";
import { formatSize, transcriptSize } from "../transcript.js";
import { bootstrapPrompt } from "../bootstrap.js";
import { binaryOnPath } from "../launch.js";
import { configDir } from "../config.js";
import {
  cliLabel,
  turnContent,
  type ConversationSummary,
  type TurnBlock,
} from "../types.js";
import {
  FabricationUnsupportedError,
  type LaunchPlan,
  type TargetAdapter,
} from "./types.js";

/**
 * OpenCode (opencode) target adapter.
 *
 * Native resume: `opencode -s <sessionId>` resumes a session stored in
 * opencode's SQLite DB at ~/.local/share/opencode/opencode.db.
 *
 * Fabrication: builds a JSON file in opencode's export/import format and
 * invokes `opencode import <file>` to load it, then resumes the imported
 * session. Unlike the other two targets, which write a new session *file*
 * into a directory the CLI scans, opencode's sessions live in one shared
 * SQLite DB — so fabrication has to go through opencode's own ingestion
 * command rather than writing storage directly. Consequence, measured:
 * import is not atomic. A payload that fails validation part-way leaves a
 * truncated session behind, so a failed import cleans up after itself before
 * handing off to bootstrap.
 *
 * Bootstrap: writes a transcript and launches a fresh session via
 * `opencode run <prompt>`, instructing the model to read the transcript.
 *
 * Format details and the evidence behind them:
 * docs/specs/opencode-session-format.md.
 */

/**
 * Validated against opencode 1.18.5 (2026-08-02) — see
 * docs/specs/opencode-session-format.md. The import validator rejects
 * unknown-shaped records outright, so this pin is a minor, not a major:
 * `state` on a tool part requires all six of status/input/output/title/
 * metadata/time, and that requirement was discovered by import failing.
 */
const VALIDATED_VERSION_PREFIXES = ["1.18."];

/** Fallback project when the launch directory maps to no known opencode project. */
const GLOBAL_PROJECT_ID = "global";

function opencodeVersion(): string | null {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}

/**
 * The project id opencode files this directory's sessions under.
 *
 * `info.projectID` is honored verbatim on import, and it is what scopes a
 * session to a repo: `opencode session list` (and the TUI's picker) shows the
 * current directory's project. The ids are opaque hashes stored in the DB's
 * `project` table, so they are looked up rather than derived — `debug scrap`
 * is the only command that exposes the mapping. Falling back to the "global"
 * project (worktree `/`, opencode's own catch-all) is what the first cut did
 * unconditionally; it works, but the session then shows up in *every*
 * project's list, so it is a fallback and not the default.
 */
function projectIdFor(cwd: string): string | null {
  const result = spawnSync("opencode", ["debug", "scrap"], { encoding: "utf8", cwd });
  if (result.status !== 0) return null;
  try {
    const projects = JSON.parse(result.stdout) as Array<{ id?: string; worktree?: string }>;
    if (!Array.isArray(projects)) return null;
    const match = projects.find((p) => p.worktree === cwd && typeof p.id === "string");
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/** A message part in opencode's export/import format. */
interface ImportPart {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: Record<string, unknown>;
  id: string;
  sessionID: string;
  messageID: string;
  snapshot?: string;
  reason?: string;
  time?: Record<string, unknown>;
}

function partId(): string {
  return `prt_tb_${randomUUID().slice(0, 12)}`;
}

function messageId(): string {
  return `msg_tb_${randomUUID().slice(0, 12)}`;
}

function textPart(text: string, sessionId: string, msgId: string): ImportPart {
  return { type: "text", text, id: partId(), sessionID: sessionId, messageID: msgId };
}

function resultBody(block: TurnBlock): string {
  return typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
}

/**
 * Tool results indexed by the call they answer, across the whole conversation.
 *
 * opencode carries a tool call and its output in one `tool` part, but the
 * canonical events split them across two turns (the result usually rides on
 * the *next* user turn), so the pairing has to be resolved up front rather
 * than while walking a single turn's blocks.
 */
function resultsByCallId(summary: ConversationSummary): Map<string, string> {
  const results = new Map<string, string>();
  for (const event of summary.events) {
    const content = turnContent(event);
    if (!content) continue;
    for (const block of content.blocks) {
      if (block.type !== "tool_result") continue;
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
      if (callId) results.set(callId, resultBody(block));
    }
  }
  return results;
}

interface ConvertOptions {
  sessionId: string;
  msgId: string;
  createdMs: number;
  results: Map<string, string>;
  /** call_ids already emitted as a `tool` part, so their result is not repeated. */
  paired: Set<string>;
  replayReasoning: boolean;
}

/**
 * Convert canonical blocks to opencode message parts.
 *
 * - text blocks → text parts
 * - thinking blocks → reasoning parts (or labeled text when replay is off)
 * - tool_use blocks → tool parts carrying the real recorded output
 * - tool_result blocks → dropped when already folded into their call's part,
 *   labeled text when the matching call never made it into this conversation
 */
function convertBlocksToParts(blocks: TurnBlock[], opts: ConvertOptions): ImportPart[] {
  const { sessionId, msgId, createdMs, results, paired, replayReasoning } = opts;
  const parts: ImportPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim()) {
          parts.push(textPart(block.text, sessionId, msgId));
        }
        break;
      case "thinking": {
        if (!block.text) break;
        const text = String(block.text);
        if (!replayReasoning) {
          parts.push(textPart(`[visible thinking]\n${text}`, sessionId, msgId));
          break;
        }
        parts.push({
          type: "reasoning",
          text,
          id: partId(),
          sessionID: sessionId,
          messageID: msgId,
          time: { start: createdMs, end: createdMs },
        });
        break;
      }
      case "tool_use": {
        const callId =
          typeof block.id === "string" && block.id ? block.id : `call_tb_${randomUUID().slice(0, 12)}`;
        const name = typeof block.name === "string" && block.name ? block.name : "ImportedTool";
        paired.add(callId);
        parts.push({
          type: "tool",
          tool: name,
          callID: callId,
          // Every key here is required by the import validator; omitting any one
          // of them fails the whole import with `Missing key at ["state"][...]`.
          state: {
            status: "completed",
            input: block.input ?? {},
            // The real recorded output when the conversation carried it. This is
            // history the model reads, never a call to re-run.
            output: results.get(callId) ?? "[historical tool call — output not captured]",
            title: name,
            metadata: {},
            time: { start: createdMs, end: createdMs },
          },
          id: partId(),
          sessionID: sessionId,
          messageID: msgId,
        });
        break;
      }
      case "tool_result": {
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        // already carried by its call's `tool` part — emitting it again would
        // show the same output twice in the rendered scrollback
        if (callId && paired.has(callId)) break;
        parts.push(textPart(`[tool result]\n${resultBody(block)}`, sessionId, msgId));
        break;
      }
      default:
        parts.push(textPart(JSON.stringify(block), sessionId, msgId));
    }
  }
  return parts;
}

/**
 * Picker title for a bridged session: the first human message, truncated.
 *
 * Same reasoning as the Claude Code adapter's: without this the session is
 * titled by turnbridge's own import notice, which is identical for every
 * bridge and describes the machinery rather than the conversation.
 */
function pickerTitle(summary: ConversationSummary): string {
  const label = cliLabel(summary.source);
  for (const event of summary.events) {
    if (event.actor.type !== "human") continue;
    const content = turnContent(event);
    const text = content?.blocks
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join(" ")
      .trim();
    if (!text) continue;
    const oneLine = text.replace(/\s+/g, " ");
    const snippet = oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
    return `${snippet} (from ${label})`;
  }
  return `Imported from ${label}`;
}

/** Milliseconds of the earliest event, for placing the import notice ahead of history. */
function earliestEventMs(summary: ConversationSummary, now: Date): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const event of summary.events) {
    const ms = Date.parse(normalizeTimestamp(event.occurred_at, now));
    if (!Number.isNaN(ms) && ms < earliest) earliest = ms;
  }
  return Number.isFinite(earliest) ? earliest : now.getTime();
}

function countReplayedReasoning(summary: ConversationSummary, replayReasoning: boolean): number {
  if (!replayReasoning) return 0;
  let count = 0;
  for (const event of summary.events) {
    const content = turnContent(event);
    if (!content) continue;
    for (const block of content.blocks) {
      if (block.type === "thinking" && block.text) count++;
    }
  }
  return count;
}

export interface ImportPayloadOptions {
  sessionId: string;
  cwd: string;
  /** opencode's own version, written into `info.version` as a native session would. */
  version: string;
  /** Project the session is filed under; scopes which directory lists it. */
  projectId: string;
  now: Date;
  replayReasoning: boolean;
}

/**
 * Build a JSON object in opencode's export/import format from canonical events.
 *
 * Exported for tests: the import itself needs a real opencode install, but the
 * payload is the part that has to be right, and every format constraint the
 * spec lists is checkable here.
 */
export function buildImportPayload(
  summary: ConversationSummary,
  opts: ImportPayloadOptions,
): Record<string, unknown> {
  const { sessionId, cwd, version, projectId, now, replayReasoning } = opts;
  const nowMs = now.getTime();
  const replayCount = countReplayedReasoning(summary, replayReasoning);

  // Unlike the file-based targets, opencode orders a session's messages by
  // `time.created`, not by position in the payload. Stamping the notice at
  // fabrication time therefore sorted it *after* every real turn, where a
  // trailing user message with no reply renders as a QUEUED prompt. Backdating
  // it just ahead of the oldest turn is what puts it where it reads as a
  // preamble; nothing about resume depends on the notice being newest.
  const noticeMs = earliestEventMs(summary, now) - 1;
  const noticeText =
    `[turnbridge import notice] This conversation was imported from ${cliLabel(summary.source)}. ` +
    "The history below is the literal visible transcript. Past tool calls are replayed as history " +
    "records, not as calls to re-run. " +
    (replayCount > 0
      ? `${replayCount} visible-thinking block(s) are replayed as reasoning; hidden reasoning and ` +
        "provider-private state were not transferred."
      : "Hidden reasoning and provider-private state were not transferred.");

  // The source model, propagated verbatim per the fabrication contract in
  // docs/WIP_TECHNICAL_DESIGN.md — never a recognized-but-false id. The
  // provider stays "turnbridge" precisely because it is not a real opencode
  // provider: the composer falls back to the user's configured model, which is
  // accurate, since this bridge did change models.
  const sourceModel =
    summary.events.find((e) => e.actor.type === "agent" && e.actor.id)?.actor.id ??
    "turnbridge-import";
  const model = { providerID: "turnbridge", modelID: sourceModel };

  const noticeId = messageId();
  const messages: Record<string, unknown>[] = [
    {
      info: {
        role: "user",
        time: { created: noticeMs },
        agent: "build",
        model,
        id: noticeId,
        sessionID: sessionId,
        summary: { diffs: [] },
      },
      parts: [textPart(noticeText, sessionId, noticeId)],
    },
  ];

  // Native sessions parent each assistant message to the *user message that
  // prompted it* — several assistant messages share one parent — and leave
  // user messages unparented. The first cut chained every message to its
  // predecessor, which parented user messages to assistant ones.
  let lastUserId: string = noticeId;
  const results = resultsByCallId(summary);
  const paired = new Set<string>();

  for (const event of summary.events) {
    const content = turnContent(event);
    if (!content) continue;
    const ts = normalizeTimestamp(event.occurred_at, now);
    const parsed = Date.parse(ts);
    const createdMs = Number.isNaN(parsed) ? nowMs : parsed;
    const role = event.actor.type === "human" ? "user" : "assistant";
    const msgId = messageId();

    const parts = convertBlocksToParts(content.blocks, {
      sessionId,
      msgId,
      createdMs,
      results,
      paired,
      replayReasoning,
    });
    if (parts.length === 0) continue;

    const info: Record<string, unknown> = {
      role,
      time: { created: createdMs },
      agent: "build",
      id: msgId,
      sessionID: sessionId,
    };

    if (role === "assistant") {
      info.mode = "build";
      info.path = { cwd, root: cwd };
      info.cost = 0;
      info.tokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      info.time = { created: createdMs, completed: createdMs };
      info.finish = "stop";
      info.modelID = event.actor.type === "agent" && event.actor.id ? event.actor.id : sourceModel;
      info.providerID = "turnbridge";
      info.parentID = lastUserId;
    } else {
      info.model = model;
      info.summary = { diffs: [] };
      lastUserId = msgId;
    }

    messages.push({ info, parts });
  }

  return {
    info: {
      id: sessionId,
      slug: `tb-${sessionId.slice(0, 8)}`,
      projectID: projectId,
      directory: cwd,
      path: "",
      title: pickerTitle(summary),
      agent: "build",
      model: { id: sourceModel, providerID: "turnbridge" },
      version,
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: nowMs, updated: nowMs },
    },
    messages,
  };
}

/** Best-effort removal of a session a failed import left half-written. */
function deleteSession(sessionId: string, cwd: string): void {
  spawnSync("opencode", ["session", "delete", sessionId], { encoding: "utf8", cwd });
}

export const opencodeTarget: TargetAdapter = {
  name: "opencode",
  binary: "opencode",

  isInstalled() {
    return binaryOnPath("opencode");
  },

  nativeResume(sessionId: string, cwd: string): LaunchPlan {
    return {
      command: "opencode",
      args: ["-s", sessionId],
      cwd,
      notes: [`resuming native OpenCode session ${sessionId}`],
    };
  },

  async fabricate(
    summary: ConversationSummary,
    cwd: string,
    opts: { replayReasoning: boolean },
  ): Promise<LaunchPlan> {
    const version = opencodeVersion();
    if (!version) {
      throw new FabricationUnsupportedError("could not determine opencode version", "opencode");
    }
    const notes: string[] = [];
    if (!VALIDATED_VERSION_PREFIXES.some((p) => version.startsWith(p))) {
      notes.push(
        `opencode ${version} has not been validated against the fabrication spec ` +
          `(validated: ${VALIDATED_VERSION_PREFIXES.map((p) => `${p}x`).join(", ")}); ` +
          "rerun with --bootstrap if the resumed session misbehaves",
      );
    }

    const projectId = projectIdFor(cwd);
    if (!projectId) {
      notes.push(
        `no opencode project registered for ${cwd}; filing the bridged session under the ` +
          "global project, where it will be listed from every directory",
      );
    }

    const sessionId = `ses_tb_${randomUUID()}`;
    const now = new Date();
    const payload = buildImportPayload(summary, {
      sessionId,
      cwd,
      version,
      projectId: projectId ?? GLOBAL_PROJECT_ID,
      now,
      replayReasoning: opts.replayReasoning,
    });

    const dir = join(configDir(), "imports");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.json`);
    const body = JSON.stringify(payload, null, 2);
    await writeFile(path, body);

    const importResult = spawnSync("opencode", ["import", path], { encoding: "utf8", cwd });
    const stdout = importResult.stdout ?? "";
    const importedId = stdout.match(/Imported session: (\S+)/)?.[1];
    if (importResult.status !== 0 || !importedId) {
      // Import is not atomic: a payload rejected part-way leaves a truncated
      // session in the DB. Drop it rather than leaving a half-conversation in
      // the user's picker, then let resume fall back to bootstrap.
      deleteSession(sessionId, cwd);
      const detail =
        importResult.status !== 0
          ? importResult.stderr || stdout || "unknown error"
          : `unrecognized import output: ${stdout.trim() || "(empty)"}`;
      throw new FabricationUnsupportedError(
        `opencode import failed (${detail.trim().replace(/\s+/g, " ")}); payload kept at ${path}`,
        "opencode",
      );
    }

    notes.push(
      `fabricated OpenCode session ${importedId} from ${cliLabel(summary.source)} history ` +
        `(${summary.turnCount} turns)`,
      `import file: ${path} (${formatSize(transcriptSize(body))})`,
    );
    const replayCount = countReplayedReasoning(summary, opts.replayReasoning);
    if (replayCount > 0) {
      notes.push(
        `replayed ${replayCount} visible-thinking block(s) as reasoning parts ` +
          "(disable with reasoningReplay: false in ~/.turnbridge/config.json or --no-reasoning-replay)",
      );
    }

    return {
      command: "opencode",
      args: ["-s", importedId],
      cwd,
      notes,
      // the id opencode actually stored, so the lineage record names the
      // session the user will be continuing in
      fabricatedConversationId: `opencode:${importedId}`,
    };
  },

  bootstrap(summary: ConversationSummary, cwd: string, transcriptPath: string): LaunchPlan {
    return {
      command: "opencode",
      args: ["run", bootstrapPrompt(summary, transcriptPath)],
      cwd,
      notes: [
        `starting a NEW OpenCode session rehydrated from ${cliLabel(summary.source)} (bootstrap mode)`,
        `transcript: ${transcriptPath}`,
      ],
    };
  },
};
