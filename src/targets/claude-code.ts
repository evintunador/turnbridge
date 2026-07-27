import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { normalizeTimestamp } from "../timestamps.js";
import { formatSize, transcriptSize } from "../transcript.js";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bootstrapPrompt } from "../bootstrap.js";
import { binaryOnPath } from "../launch.js";
import { cliLabel, turnContent, type ConversationSummary, type TurnBlock } from "../types.js";
import { FabricationUnsupportedError, type LaunchPlan, type TargetAdapter } from "./types.js";

/**
 * Session writer validated against Claude Code 2.1.x (2026-07): resume looks
 * up <uuid>.jsonl only inside the project directory encoded from the launch
 * cwd; the conversation is reconstructed by walking parentUuid links backward
 * from the last line, and timestamps are required on every line.
 */
const VALIDATED_VERSION_PREFIX = "2.";

function claudeVersion(): string | null {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}

/** ~/.claude/projects key: every non-alphanumeric cwd character becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function projectsDir(): string {
  return join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
}

interface SessionLine {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: string;
  entrypoint: string;
  cwd: string;
  sessionId: string;
  version: string;
  type: "user" | "assistant";
  message: Record<string, unknown>;
  uuid: string;
  timestamp: string;
}

interface LineSpec {
  type: "user" | "assistant";
  content: unknown;
  timestamp: string;
  model?: string;
}

/**
 * Convert canonical blocks to Claude-native content blocks. Foreign tool
 * calls keep their names (history is replayed as context, never re-executed);
 * thinking blocks are folded to labeled text — their signatures can't be
 * forged and must not be fabricated.
 */
function convertBlocks(
  blocks: TurnBlock[],
  seenToolUseIds: Set<string>,
): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim()) {
          out.push({ type: "text", text: block.text });
        }
        break;
      case "thinking":
        if (block.text) out.push({ type: "text", text: `[visible thinking]\n${String(block.text)}` });
        break;
      case "tool_use": {
        const id = typeof block.id === "string" ? block.id : `toolu_tb_${randomUUID().slice(0, 8)}`;
        seenToolUseIds.add(id);
        const input =
          block.input && typeof block.input === "object" ? block.input : { value: block.input ?? null };
        out.push({ type: "tool_use", id, name: block.name ?? "ImportedTool", input });
        break;
      }
      case "tool_result": {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (id && seenToolUseIds.has(id)) {
          const content =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          out.push({ type: "tool_result", tool_use_id: id, content });
        } else {
          // orphaned result — replay as labeled text rather than break pairing
          out.push({
            type: "text",
            text: `[tool result]\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")}`,
          });
        }
        break;
      }
      default:
        out.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  return out;
}

export function buildSessionLines(
  summary: ConversationSummary,
  sessionId: string,
  cwd: string,
  version: string,
  now: Date,
): SessionLine[] {
  const specs: LineSpec[] = [
    {
      type: "user",
      // Fabrication time, which is *newer* than every history line below it, so
      // the file steps backward exactly once at line 1. Deliberate pending the
      // ordering probe (docs/specs/claude-session-format.md §7): backdating this
      // to just before the first real event would make the file monotonic, but
      // if the resume picker sorts on line timestamps rather than file mtime it
      // would also bury a freshly bridged session under genuinely old ones.
      // Don't "fix" the ordering until that trade-off is measured.
      timestamp: now.toISOString(),
      content: [
        {
          type: "text",
          text:
            `[turnbridge import notice] This conversation was imported from ${cliLabel(summary.source)}. ` +
            "The history below is the literal visible transcript; hidden reasoning and provider-private " +
            "state were not transferred, and historical tool calls are context only.",
        },
      ],
    },
  ];

  const seenToolUseIds = new Set<string>();
  for (const event of summary.events) {
    const content = turnContent(event);
    if (!content) continue;
    const blocks = convertBlocks(content.blocks, seenToolUseIds);
    if (blocks.length === 0) continue;
    // tool results ride on user lines in Claude's format
    const type = event.actor.type === "human" || content.role === "tool_result" ? "user" : "assistant";
    const spec: LineSpec = {
      type,
      content: blocks,
      timestamp: normalizeTimestamp(event.occurred_at, now),
    };
    if (type === "assistant" && event.actor.type === "agent" && event.actor.id) {
      spec.model = event.actor.id;
    }
    specs.push(spec);
  }

  const lines: SessionLine[] = [];
  let parentUuid: string | null = null;
  for (const spec of specs) {
    const uuid = randomUUID();
    const message: Record<string, unknown> =
      spec.type === "assistant"
        ? {
            // full envelope: defends against stricter validation in other versions
            model: spec.model ?? "turnbridge-import",
            id: `msg_tb_${uuid.slice(0, 8)}`,
            type: "message",
            role: "assistant",
            content: spec.content,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        : { role: "user", content: spec.content };
    lines.push({
      parentUuid,
      isSidechain: false,
      userType: "external",
      entrypoint: "cli",
      cwd,
      sessionId,
      version,
      type: spec.type,
      message,
      uuid,
      timestamp: spec.timestamp,
    });
    parentUuid = uuid;
  }
  return lines;
}

export const claudeCodeTarget: TargetAdapter = {
  name: "claude-code",
  binary: "claude",

  isInstalled() {
    return binaryOnPath("claude");
  },

  nativeResume(sessionId: string, cwd: string): LaunchPlan {
    return {
      command: "claude",
      args: ["--resume", sessionId],
      cwd,
      notes: [`resuming native Claude Code session ${sessionId}`],
    };
  },

  // `opts.replayReasoning` doesn't apply here: only Codex issues opaque
  // reasoning ciphertext, and it can't be forged as a native Claude Code
  // reasoning item, so there is nothing for this target to replay.
  async fabricate(summary: ConversationSummary, cwd: string): Promise<LaunchPlan> {
    const version = claudeVersion();
    if (!version) {
      throw new FabricationUnsupportedError("could not determine claude version", "claude-code");
    }
    const notes: string[] = [];
    if (!version.startsWith(VALIDATED_VERSION_PREFIX)) {
      notes.push(
        `claude ${version} has not been validated against the fabrication spec (pinned ${VALIDATED_VERSION_PREFIX}x); ` +
          "rerun with --bootstrap if the resumed session misbehaves",
      );
    }

    const sessionId = randomUUID();
    // resume lookup is scoped to the project dir encoded from the launch cwd
    const dir = join(projectsDir(), encodeProjectDir(cwd));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    const lines = buildSessionLines(summary, sessionId, cwd, version, new Date());
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await writeFile(path, body);

    notes.push(
      `fabricated Claude Code session ${sessionId} from ${cliLabel(summary.source)} history (${summary.turnCount} turns)`,
      `session file: ${path} (${formatSize(transcriptSize(body))})`,
    );
    return {
      command: "claude",
      args: ["--resume", sessionId],
      cwd,
      notes,
      fabricatedConversationId: `claude-code:${sessionId}`,
    };
  },

  bootstrap(summary: ConversationSummary, cwd: string, transcriptPath: string): LaunchPlan {
    return {
      command: "claude",
      args: [bootstrapPrompt(summary, transcriptPath)],
      cwd,
      notes: [
        `starting a NEW Claude Code session rehydrated from ${cliLabel(summary.source)} (bootstrap mode)`,
        `transcript: ${transcriptPath}`,
      ],
    };
  },
};
