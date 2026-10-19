import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../config.js";
import { bootstrapTarget } from "./bootstrap-targets.js";
import { buildTextImport } from "./text-import.js";
import { FabricationUnsupportedError, type TargetAdapter } from "./types.js";

const base = bootstrapTarget("goose");
/** Use Goose's own public Pi JSONL importer instead of writing its database. */
export const gooseTarget: TargetAdapter = { ...base, supportsNativeImport: true,
  async fabricate(summary, cwd) {
    const version = spawnSync(base.binary, ["--version"], { encoding: "utf8", timeout: 10000 }).stdout?.match(/\d+\.\d+\.\d+/)?.[0];
    if (!version?.startsWith("1.52.")) throw new FabricationUnsupportedError("Goose native importer format is checked for 1.52.x", "goose");
    const id = randomUUID(), directory = join(configDir(), "imports");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `goose-${id}.jsonl`);
    const payload = buildTextImport(summary, "pi", id, cwd, "0.87.1");
    await writeFile(path, payload.lines.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
    const imported = spawnSync(base.binary, ["session", "import", path], { cwd, encoding: "utf8", timeout: 30000 });
    const sessionId = imported.stdout?.match(/(?:Session ID|Imported session|session imported)[\s:]+([\w-]+)/i)?.[1];
    if (imported.status !== 0 || !sessionId) throw new FabricationUnsupportedError(`Goose importer did not return a session ID: ${(imported.stderr || imported.stdout || "empty output").slice(-1000)}`, "goose");
    return { ...base.nativeResume(sessionId, cwd), notes: [`fabricated Goose visible history via its native Pi importer (${version}); foreign structured blocks are labeled text`, `import file: ${path}`],
      fabricatedConversationId: `goose:${sessionId}`, importedSourceEventIds: payload.importedSourceEventIds };
  },
};
