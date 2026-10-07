import { bridgeMatrix, HUBS, requiredGates } from "./matrix.js";
import { TARGET_CLIS } from "./roster.js";

// Planning only: never presents absent drivers or installed binaries as passes.
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  cledgerBaseline: "f9853f7b38ee1fefdb587748055a18e240efb48c",
  hubs: HUBS,
  roster: TARGET_CLIS,
  scenarios: bridgeMatrix().map(scenario => ({ ...scenario, status: "not-run", requiredGates: requiredGates(scenario.mode) })),
}, null, 2) + "\n");
