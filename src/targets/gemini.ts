import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bootstrapTarget } from "./bootstrap-targets.js";
import { foldedTurns } from "./text-import.js";
import { FabricationUnsupportedError, type TargetAdapter } from "./types.js";
import { importSourceLabel, type ConversationSummary } from "../types.js";

/** Gemini 0.61's append-only native chat format; foreign records remain labeled text. */
export function buildGeminiImport(summary: ConversationSummary, sessionId: string, cwd: string, now = new Date()) {
  const timestamp = now.toISOString();
  const turns = foldedTurns(summary);
  const notice = { role: "user" as const, text: `[turnbridge import notice] Visible conversation imported from ${importSourceLabel(summary)}. Foreign tools, thinking and attachment references are labeled historical text. Hidden state was not transferred.`, timestamp };
  return {
    lines: [
      { sessionId, projectHash: createHash("sha256").update(cwd).digest("hex"), startTime: timestamp, lastUpdated: timestamp, kind: "main" },
      ...[notice, ...turns].map(turn => ({ id: randomUUID(), timestamp: Number.isFinite(Date.parse(turn.timestamp)) ? new Date(turn.timestamp).toISOString() : timestamp,
        type: turn.role === "assistant" ? "gemini" : "user", content: [{ text: turn.text }] })),
    ],
    importedSourceEventIds: turns.map(turn => turn.eventId),
  };
}

const base = bootstrapTarget("gemini-cli");
export const geminiTarget: TargetAdapter = { ...base, supportsNativeImport: true, async fabricate(summary, cwd) {
  const result = spawnSync(base.binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const version = result.stdout?.match(/\d+\.\d+\.\d+/)?.[0];
  if (result.status !== 0 || !version?.startsWith("0.61.")) throw new FabricationUnsupportedError("Gemini version is outside the 0.61.x native JSONL format", "gemini-cli");
  // Let the public CLI register its own project ID and perform migrations. Never
  // modify the shared registry ourselves or import private installed internals.
  const listed = spawnSync(base.binary, ["--list-sessions"], { encoding: "utf8", cwd, timeout: 30_000 });
  if (listed.status !== 0) throw new FabricationUnsupportedError("Gemini could not register/list the native project", "gemini-cli");
  const home = process.env.GEMINI_CLI_HOME ?? homedir();
  const runtime = process.env.SANDBOX === "sandbox-exec" ? join(home, ".cache", ".gemini") : join(home, ".gemini");
  const canonicalCwd = await realpath(cwd);
  let project: unknown;
  try { const registry = JSON.parse(await readFile(join(runtime, "projects.json"), "utf8")); project = registry.projects?.[cwd] ?? registry.projects?.[canonicalCwd]; }
  catch { throw new FabricationUnsupportedError("Gemini native project registry is unavailable", "gemini-cli"); }
  if (typeof project !== "string" || !project || /[/\\]/.test(project) || project === "." || project === "..") throw new FabricationUnsupportedError("Gemini native project ID is invalid", "gemini-cli");
  const sessionId = randomUUID(), now = new Date();
  const directory = join(runtime, "tmp", project, "chats");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `session-${now.toISOString().slice(0, 16).replace(/:/g, "-")}-${sessionId.slice(0, 8)}.jsonl`);
  const payload = buildGeminiImport(summary, sessionId, canonicalCwd, now);
  await writeFile(path, payload.lines.map(line => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return { command: base.binary, args: ["--resume", sessionId], cwd, notes: ["fabricated Gemini native session from visible text; foreign structured blocks are labeled text", `session file: ${path}`, `format checked for ${version}; installed bridge verification is recorded separately`],
    fabricatedConversationId: `gemini-cli:${sessionId}`, importedSourceEventIds: payload.importedSourceEventIds };
} };
