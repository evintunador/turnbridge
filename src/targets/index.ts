import type { CliName } from "../types.js";
import { claudeCodeTarget } from "./claude-code.js";
import { codexTarget } from "./codex.js";
import { createOpenCodeTarget, opencodeTarget } from "./opencode.js";
import type { TargetAdapter } from "./types.js";
import { CLI_CATALOG } from "../cli-catalog.js";
import { bootstrapTarget } from "./bootstrap-targets.js";
import { textImportTarget } from "./text-import.js";
import { gooseTarget } from "./goose.js";
import { geminiTarget } from "./gemini.js";

export const targets: Record<CliName, TargetAdapter> = {
  ...Object.fromEntries(CLI_CATALOG.filter(cli => !["claude-code", "codex", "opencode"].includes(cli.id)).map(cli => [cli.id, bootstrapTarget(cli.id)])) as Record<CliName, TargetAdapter>,
  "claude-code": claudeCodeTarget,
  codex: codexTarget,
  opencode: opencodeTarget,
  pi: textImportTarget("pi"),
  "qwen-code": textImportTarget("qwen-code"),
  kilo: createOpenCodeTarget("kilo"),
  goose: gooseTarget,
  "gemini-cli": geminiTarget,
};

export function targetFor(name: CliName): TargetAdapter {
  return targets[name];
}

export async function installedTargets(): Promise<TargetAdapter[]> {
  const results: TargetAdapter[] = [];
  for (const adapter of Object.values(targets)) {
    if (await adapter.isInstalled()) results.push(adapter);
  }
  return results;
}
