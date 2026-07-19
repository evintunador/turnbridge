import { spawnSync } from "node:child_process";
import type { LaunchPlan } from "./targets/types.js";

export async function binaryOnPath(binary: string): Promise<boolean> {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  return result.status === 0;
}

/** Hand the terminal over to the target CLI; returns its exit code. */
export function runLaunchPlan(plan: LaunchPlan): number {
  for (const note of plan.notes) process.stderr.write(`turnbridge: ${note}\n`);
  const result = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`turnbridge: failed to launch ${plan.command}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}
