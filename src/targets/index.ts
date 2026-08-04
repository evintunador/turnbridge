import type { CliName } from "../types.js";
import { claudeCodeTarget } from "./claude-code.js";
import { codexTarget } from "./codex.js";
import { opencodeTarget } from "./opencode.js";
import type { TargetAdapter } from "./types.js";

export const targets: Record<CliName, TargetAdapter> = {
  "claude-code": claudeCodeTarget,
  codex: codexTarget,
  opencode: opencodeTarget,
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
