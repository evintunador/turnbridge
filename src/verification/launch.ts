import { readFile } from "node:fs/promises";
import { runInteractiveLaunchPlan } from "../interactive-launch.js";
import type { LaunchPlan } from "../targets/types.js";

// Invoked inside the test PTY, so the production relay sees a real user terminal.
const plan = JSON.parse(await readFile(process.argv[2]!, "utf8")) as LaunchPlan;
process.exitCode = await runInteractiveLaunchPlan(plan);
