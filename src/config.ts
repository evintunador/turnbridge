import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliName } from "./types.js";

export interface TurnbridgeConfig {
  /** Target CLI used when `turnbridge resume` is called without one. */
  defaultTarget?: CliName;
  /**
   * Replay a Codex-origin conversation's opaque `reasoning` blobs when
   * fabricating it back into Codex, restoring hidden reasoning provider-side
   * (see docs/WIP_TECHNICAL_DESIGN.md). Default on; set false to opt out.
   */
  reasoningReplay?: boolean;
}

export function configDir(): string {
  return process.env["TURNBRIDGE_HOME"] ?? join(homedir(), ".turnbridge");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<TurnbridgeConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const data = JSON.parse(raw) as TurnbridgeConfig;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export async function saveConfig(config: TurnbridgeConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n");
}
