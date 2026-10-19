import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { bridgeMatrix, latestEvidence, scenarioKey, type BridgeEvidence } from "./matrix.js";

export function buildReport(runs: readonly BridgeEvidence[]) {
  const latest = latestEvidence(runs);
  return {
    schemaVersion: 1,
    // Latest status is per exact version pair and inference tier, never a blanket support claim.
    scenarios: bridgeMatrix().map(scenario => {
      const evidence = latest.filter(run => scenarioKey(run) === scenarioKey(scenario));
      return { ...scenario, evidence, ...(evidence.length ? {} : { status: "not-run" as const }) };
    }),
  };
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (!paths.length) throw Error("Usage: node dist/verification/report.js <evidence.json> [...]");
  const runs: BridgeEvidence[] = [];
  for (const path of paths) {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw Error(`${path}: expected an array of bridge evidence`);
    if (value.some(run => !run || typeof run !== "object")) throw Error(`${path}: expected evidence objects`);
    runs.push(...value as BridgeEvidence[]);
  }
  process.stdout.write(JSON.stringify(buildReport(runs), null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`turnbridge verification: ${String(error)}\n`); process.exitCode = 1; });
}
