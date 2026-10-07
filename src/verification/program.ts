import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_CATALOG } from "../cli-catalog.js";
import { targets } from "../targets/index.js";
import { type CliName, parseCliName } from "../types.js";
import { runInstalledScenario } from "./campaign.js";
import { HUBS, validateEvidence, type BridgeEvidence, type BridgeMode } from "./matrix.js";
import { buildReport } from "./report.js";

/** Smoke observations remain separate from genuine installed-source bridges. */
export function bridgeEvidence(report: Record<string, unknown>): BridgeEvidence | undefined {
  if (report.sourceProof !== "installed-capture" || !["darwin", "linux"].includes(String(report.platform))) return;
  if (![report.sourceVersion, report.targetVersion].every(v => typeof v === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v))) return;
  const evidence = report as unknown as BridgeEvidence;
  validateEvidence(evidence);
  return evidence;
}

export async function runProgram(options: { cledger: string; output: string; runtimeDirectory?: string; hub?: CliName; only?: CliName[]; timeoutMs?: number; sourceSnapshots?: Partial<Record<CliName, string>> }) {
  await mkdir(options.output, { recursive: true });
  if (options.runtimeDirectory) {
    const manifest = JSON.parse(await readFile(join(options.runtimeDirectory, "runtimes.json"), "utf8"));
    for (const runtime of manifest.runtimes) process.env[`TURNBRIDGE_VERIFY_${String(runtime.cli).toUpperCase().replaceAll("-", "_")}_BINARY`] = runtime.path;
  }
  const observations: Record<string, unknown>[] = [], evidence: BridgeEvidence[] = [];
  const snapshots = new Map<CliName, string>();
  for (const [cli, path] of Object.entries(options.sourceSnapshots ?? {})) {
    const name = parseCliName(cli);
    if (!name || !path || snapshots.has(name)) throw Error(`Invalid or duplicate configured source snapshot: ${cli}`);
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    if (snapshot.proof !== "installed-capture" || snapshot.summary.source !== name) throw Error(`Source snapshot does not establish ${name} installed capture`);
    snapshots.set(name, resolve(path));
  }
  const persist = async () => {
    await writeFile(join(options.output, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
    await writeFile(join(options.output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await writeFile(join(options.output, "matrix.json"), JSON.stringify(buildReport(evidence), null, 2) + "\n");
  };
  const run = async (source: CliName, target: CliName, mode: BridgeMode, sourceFile?: string) => {
    const binary = process.env[`TURNBRIDGE_VERIFY_${target.toUpperCase().replaceAll("-", "_")}_BINARY`];
    process.stderr.write(`Verifying ${source} → ${target} (${mode}, ${sourceFile ? "installed source" : "target smoke"})\n`);
    const report = await runInstalledScenario({ source, target, mode, cledger: options.cledger, outputDirectory: options.output,
      timeoutMs: options.timeoutMs ?? 45_000, ...(binary ? { binary } : {}), ...(sourceFile ? { sourceFile } : {}),
      ...((process.env.TURNBRIDGE_AIDER_PYTHON ?? process.env.TURNBRIDGE_VERIFY_AIDER_BINARY) ? { aiderPython: (process.env.TURNBRIDGE_AIDER_PYTHON ?? process.env.TURNBRIDGE_VERIFY_AIDER_BINARY)! } : {}) });
    observations.push(report);
    const qualified = bridgeEvidence(report); if (qualified) evidence.push(qualified);
    // Snapshot discovery is confined to this run's artifacts, never newest-session heuristics.
    const directory = report.artifacts?.length ? dirname(report.artifacts[0]) : undefined;
    if (!snapshots.has(target) && directory && (await readdir(directory)).includes("source-snapshot.json")) snapshots.set(target, join(directory, "source-snapshot.json"));
    process.stderr.write(`[${report.status}] ${report.reason || "all gates passed"}\n`);
    await persist();
    return report;
  };
  const roster = options.only ?? CLI_CATALOG.map(cli => cli.id);
  const hubs = options.hub ? [options.hub] : [...HUBS];
  // Seed one actual captured stream per source, including hubs. Prefer native
  // import so original visible markers exist in scrollback rather than only a tool.
  for (const target of [...new Set([...roster, ...hubs])]) {
    if (snapshots.has(target)) continue;
    const source = target === "codex" ? "claude-code" : "codex";
    const mode = targets[target].supportsNativeImport === false ? "bootstrap" : "native-import";
    await run(source, target, mode);
    if (!snapshots.has(target) && mode === "native-import") await run(source, target, "bootstrap");
  }
  const visited = new Set<string>();
  for (const hub of hubs) for (const other of roster) for (const [source, target] of [[hub, other], [other, hub]] as [CliName, CliName][]) {
    if (source === target) continue;
    for (const mode of ["native-import", "bootstrap"] as const) {
      const key = `${source}->${target}/${mode}`; if (visited.has(key)) continue; visited.add(key);
      const sourceFile = snapshots.get(source);
      if (!sourceFile) {
        observations.push({ source, target, mode, platform: process.platform, status: "blocked", reason: "No automatically captured installed source snapshot", sourceProof: "unavailable" });
        await persist(); continue;
      }
      await run(source, target, mode, sourceFile);
    }
  }
  return { observations, evidence };
}

async function main() {
  const args = process.argv.slice(2), values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--cledger", "--output", "--runtime-dir", "--hub", "--only", "--timeout-ms", "--sources"].includes(args[i]!) || !args[i + 1]) throw Error(`Invalid option ${args[i]}`);
    values.set(args[i]!, args[i + 1]!);
  }
  const cledger = values.get("--cledger") ?? process.env.TURNBRIDGE_VERIFY_CLEDGER;
  if (!cledger || !values.get("--output")) throw Error("Usage: program.js --cledger PATH --output DIRECTORY [--runtime-dir DIRECTORY] [--hub CLI] [--only CLI,...]");
  const parse = (value: string): CliName => { const cli = parseCliName(value); if (!cli) throw Error(`Unknown CLI ${value}`); return cli; };
  const hub = values.has("--hub") ? parse(values.get("--hub")!) : undefined;
  if (hub && !HUBS.some(id => id === hub)) throw Error("--hub must select Claude, Codex or OpenCode");
  const timeoutMs = Number(values.get("--timeout-ms") ?? 45000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw Error("Invalid timeout");
  const result = await runProgram({ cledger: resolve(cledger), output: resolve(values.get("--output")!), timeoutMs,
    ...(hub ? { hub } : {}), ...(values.has("--only") ? { only: values.get("--only")!.split(",").map(parse) } : {}),
    ...(values.has("--sources") ? { sourceSnapshots: JSON.parse(await readFile(values.get("--sources")!, "utf8")) } : {}),
    ...(values.has("--runtime-dir") ? { runtimeDirectory: resolve(values.get("--runtime-dir")!) } : {}) });
  // A matrix run is exploratory: retain failures without masking core regressions.
  if (!result.evidence.some(run => run.status === "pass")) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
