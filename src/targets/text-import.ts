import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapTarget } from "./bootstrap-targets.js";
import { FabricationUnsupportedError, type TargetAdapter } from "./types.js";
import { blockToMarkdown } from "../transcript.js";
import { importSourceLabel, turnContent, type ConversationSummary } from "../types.js";

/** Foreign tool records are explicit visible text, never executable native tool calls. */
export function foldedTurns(summary: ConversationSummary) {
  return summary.events.flatMap(event => {
    const content = turnContent(event);
    if (!content) return [];
    const text = content.blocks.map(blockToMarkdown).filter(Boolean).join("\n\n");
    if (!text.trim()) return [];
    return [{ role: content.role === "assistant" ? "assistant" as const : "user" as const, text, eventId: event.id, timestamp: event.occurred_at }];
  });
}

export function buildTextImport(summary: ConversationSummary, target: "pi" | "qwen-code", sessionId: string, cwd: string, version: string) {
  const rows = [{ role: "user" as const, text: `[turnbridge import notice] Visible conversation imported from ${importSourceLabel(summary)}. Foreign tool calls/results and thinking are labeled text. This session has no original hidden state.`,
    eventId: "", timestamp: "2000-01-01T00:00:00.000Z" }, ...foldedTurns(summary)];
  let parent: string | null = null;
  const messages = rows.map(row => {
    const id = randomUUID();
    const previous = parent; parent = id;
    const stamp = Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : new Date().toISOString();
    if (target === "qwen-code") return { type: row.role, uuid: id, parentUuid: previous, sessionId, cwd, version, timestamp: stamp,
      ...(row.role === "assistant" ? { model: "turnbridge-import" } : {}), message: { role: row.role === "assistant" ? "model" : "user", parts: [{ text: row.text }] } };
    return { type: "message", id, parentId: previous, timestamp: stamp, message: {
      role: row.role, content: [{ type: "text", text: row.text }], timestamp: Date.parse(stamp),
      ...(row.role === "assistant" ? { api: "openai-completions", provider: "turnbridge", model: "turnbridge-import", stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}),
    } };
  });
  return { lines: target === "pi" ? [{ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }, ...messages] : messages,
    importedSourceEventIds: rows.filter(row => row.eventId).map(row => row.eventId) };
}

export function textImportTarget(name: "pi" | "qwen-code"): TargetAdapter {
  const base = bootstrapTarget(name), prefixes = name === "pi" ? ["0.87."] : ["0.24."];
  return { ...base, supportsNativeImport: true, async fabricate(summary, cwd) {
    const result = spawnSync(base.binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const version = result.stdout?.match(/\d+\.\d+\.\d+/)?.[0];
    if (result.status !== 0 || !version || !prefixes.some(prefix => version.startsWith(prefix))) throw new FabricationUnsupportedError(`${name} version is outside the native text-import format (${prefixes.join(", ")})`, name);
    const id = randomUUID(), now = new Date().toISOString();
    const directory = name === "pi"
      ? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)
      : join(process.env.QWEN_RUNTIME_DIR ?? join(homedir(), ".qwen"), "projects", cwd.replace(/[/.]/g, "-"), "chats");
    await mkdir(directory, { recursive: true });
    const path = join(directory, name === "pi" ? `${now.replace(/[:.]/g, "-")}_${id}.jsonl` : `${id}.jsonl`);
    const payload = buildTextImport(summary, name, id, cwd, version);
    await writeFile(path, payload.lines.map(line => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
    return { command: base.binary, args: name === "pi" ? ["--session", path] : ["--resume", id], cwd,
      notes: [`fabricated ${name} native session from visible text; foreign structured blocks are labeled text`, `session file: ${path}`, `format checked for ${version}; installed bridge verification is recorded separately`],
      fabricatedConversationId: `${name}:${id}`, importedSourceEventIds: payload.importedSourceEventIds };
  } };
}
