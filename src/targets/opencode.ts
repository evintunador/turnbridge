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
 * invokes `opencode import <file>` to load it into the DB, then resumes
 * the imported session. This approach uses opencode's own ingestion
 * machinery rather than writing SQLite directly.
 *
 * Bootstrap: writes a transcript and launches a fresh session via
 * `opencode run <prompt>`, instructing the model to read the transcript.
 */

const VALIDATED_VERSION_PREFIX = "1.";

function opencodeVersion(): string | null {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}

/**
 * A message part in opencode's export/import format.
 */
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

/**
 * Convert canonical blocks to opencode message parts.
 *
 * - text blocks → text parts
 * - thinking blocks → reasoning parts
 * - tool_use blocks → tool parts (historical, never re-executed)
 * - tool_result blocks → folded to labeled text (no native tool-result part)
 */
function convertBlocksToParts(
  blocks: TurnBlock[],
  sessionId: string,
  messageId: string,
  seenCallIds: Set<string>,
): ImportPart[] {
  const parts: ImportPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim()) {
          parts.push({
            type: "text",
            text: block.text,
            id: `prt_tb_${randomUUID().slice(0, 12)}`,
            sessionID: sessionId,
            messageID: messageId,
          });
        }
        break;
      case "thinking":
        if (block.text) {
          parts.push({
            type: "reasoning",
            text: String(block.text),
            id: `prt_tb_${randomUUID().slice(0, 12)}`,
            sessionID: sessionId,
            messageID: messageId,
            time: { start: 0, end: 0 },
          });
        }
        break;
      case "tool_use": {
        const callId =
          typeof block.id === "string" && block.id
            ? block.id
            : `call_tb_${randomUUID().slice(0, 12)}`;
        seenCallIds.add(callId);
        parts.push({
          type: "tool",
          tool: block.name ?? "ImportedTool",
          callID: callId,
          state: {
            status: "completed",
            input: block.input ?? {},
            output: "[historical tool call — not re-executed]",
          },
          id: `prt_tb_${randomUUID().slice(0, 12)}`,
          sessionID: sessionId,
          messageID: messageId,
        });
        break;
      }
      case "tool_result": {
        const body =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        parts.push({
          type: "text",
          text: `[tool result]\n${body}`,
          id: `prt_tb_${randomUUID().slice(0, 12)}`,
          sessionID: sessionId,
          messageID: messageId,
        });
        break;
      }
      default:
        parts.push({
          type: "text",
          text: JSON.stringify(block),
          id: `prt_tb_${randomUUID().slice(0, 12)}`,
          sessionID: sessionId,
          messageID: messageId,
        });
    }
  }
  return parts;
}

/**
 * Picker title for a bridged session: the first human message, truncated.
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

/**
 * Build a JSON object in opencode's export/import format from canonical events.
 */
function buildImportPayload(
  summary: ConversationSummary,
  sessionId: string,
  cwd: string,
  now: Date,
): Record<string, unknown> {
  const nowMs = now.getTime();
  const slug = `tb-${sessionId.slice(0, 8)}`;
  const model = { providerID: "turnbridge", modelID: "imported" };

  const userMessageId = `msg_tb_${randomUUID().slice(0, 12)}`;
  const noticeText =
    `[turnbridge import notice] This conversation was imported from ${cliLabel(summary.source)}. ` +
    "The history below is the literal visible transcript; hidden reasoning and provider-private " +
    "state were not transferred, and historical tool calls are context only.";

  const messages: Record<string, unknown>[] = [
    {
      info: {
        role: "user",
        time: { created: nowMs },
        agent: "turnbridge",
        model,
        id: userMessageId,
        sessionID: sessionId,
        summary: { diffs: [] },
      },
      parts: [
        {
          type: "text",
          text: noticeText,
          id: `prt_tb_${randomUUID().slice(0, 12)}`,
          sessionID: sessionId,
          messageID: userMessageId,
        },
      ],
    },
  ];

  let parentId = userMessageId;
  const seenCallIds = new Set<string>();

  for (const event of summary.events) {
    const content = turnContent(event);
    if (!content) continue;
    const ts = normalizeTimestamp(event.occurred_at, now);
    const createdMs = Date.parse(ts);
    const role = event.actor.type === "human" ? "user" : "assistant";
    const msgId = `msg_tb_${randomUUID().slice(0, 12)}`;

    const parts = convertBlocksToParts(content.blocks, sessionId, msgId, seenCallIds);
    if (parts.length === 0) continue;

    const info: Record<string, unknown> = {
      role,
      time: { created: Number.isNaN(createdMs) ? nowMs : createdMs },
      agent: "turnbridge",
      id: msgId,
      sessionID: sessionId,
      parentID: parentId,
    };

    if (role === "assistant") {
      info.mode = "chat";
      info.path = { cwd, root: cwd };
      info.cost = 0;
      info.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      info.finish = "stop";
      info.modelID = "turnbridge-import";
      info.providerID = "turnbridge";
    } else {
      info.model = model;
      info.summary = { diffs: [] };
    }

    messages.push({ info, parts });
    parentId = msgId;
  }

  return {
    info: {
      id: sessionId,
      slug,
      projectID: "global",
      directory: cwd,
      path: "",
      title: pickerTitle(summary),
      agent: "turnbridge",
      model: { id: "turnbridge-import", providerID: "turnbridge", variant: "imported" },
      version: "1.0.0",
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: nowMs, updated: nowMs },
      permission: [],
    },
    messages,
  };
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
    _opts: { replayReasoning: boolean },
  ): Promise<LaunchPlan> {
    const version = opencodeVersion();
    if (!version) {
      throw new FabricationUnsupportedError(
        "could not determine opencode version",
        "opencode",
      );
    }
    const notes: string[] = [];
    if (!version.startsWith(VALIDATED_VERSION_PREFIX)) {
      notes.push(
        `opencode ${version} has not been validated against the fabrication spec ` +
          `(pinned ${VALIDATED_VERSION_PREFIX}x); ` +
          "rerun with --bootstrap if the resumed session misbehaves",
      );
    }

    const sessionId = `ses_tb_${randomUUID()}`;
    const now = new Date();
    const payload = buildImportPayload(summary, sessionId, cwd, now);

    const dir = join(configDir(), "imports");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.json`);
    const body = JSON.stringify(payload, null, 2);
    await writeFile(path, body);

    const importResult = spawnSync("opencode", ["import", path], {
      encoding: "utf8",
      cwd,
    });
    if (importResult.status !== 0) {
      throw new Error(
        `opencode import failed: ${importResult.stderr || importResult.stdout || "unknown error"}`,
      );
    }
    const importedId = (importResult.stdout ?? "").match(
      /Imported session: (\S+)/,
    )?.[1];
    if (!importedId) {
      throw new Error(
        "could not parse imported session id from opencode import output",
      );
    }

    notes.push(
      `fabricated OpenCode session ${sessionId} from ${cliLabel(summary.source)} history ` +
        `(${summary.turnCount} turns)`,
      `import file: ${path} (${formatSize(transcriptSize(body))})`,
    );

    return {
      command: "opencode",
      args: ["-s", importedId],
      cwd,
      notes,
      fabricatedConversationId: `opencode:${sessionId}`,
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
