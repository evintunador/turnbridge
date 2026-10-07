import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_CATALOG } from "../cli-catalog.js";
import { parseCliName, type CliName } from "../types.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import type { BridgeMode } from "./matrix.js";
import { validateLocalModel, validateInferenceProvider, type LocalModelConfig } from "./local-model.js";
import type { WorkerOptions } from "./worker.js";

export async function runInstalledScenario(options: {
  target: CliName; source: CliName; mode: BridgeMode; cledger: string; binary?: string; sourceFile?: string;
  outputDirectory: string; timeoutMs?: number; aiderPython?: string; localModel?: LocalModelConfig;
}) {
  await mkdir(options.outputDirectory, { recursive: true });
  const root = await realpath(await mkdtemp(join(options.outputDirectory, `${options.source}-to-${options.target}-${options.mode}-`)));
  const bin = join(root, "bin");
  for (const path of [bin, join(root, "tmp")]) await mkdir(path, { recursive: true });
  const command = CLI_CATALOG.find(cli => cli.id === options.target)!.command;
  if (options.binary) await symlink(await realpath(options.binary), join(bin, command));
  const cledger = await realpath(options.cledger);
  await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(cledger)});\n`, { mode: 0o755 });
  const env = isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
  delete env.CI; delete env.NO_COLOR;
  Object.assign(env, { TERM: "xterm-256color", TURNBRIDGE_HOME: join(root, ".turnbridge") });
  if (options.aiderPython) env.TURNBRIDGE_AIDER_PYTHON = resolve(options.aiderPython);
  if (options.localModel) {
    validateInferenceProvider(options.localModel);
    if (options.localModel.tier === "usual-provider") {
      if (!process.env.TURNBRIDGE_VERIFY_PROVIDER_API_KEY) throw Error("Set the dedicated TURNBRIDGE_VERIFY_PROVIDER_API_KEY explicitly for a paid canary");
      env.TURNBRIDGE_VERIFY_PROVIDER_API_KEY = process.env.TURNBRIDGE_VERIFY_PROVIDER_API_KEY;
    }
  }
  const spec: WorkerOptions = { root, source: options.source, target: options.target, mode: options.mode, cledger,
    ...(options.localModel ? { localModel: options.localModel } : {}), ...(options.sourceFile ? { sourceFile: await realpath(options.sourceFile) } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
  const input = join(root, "options.json");
  await writeFile(input, JSON.stringify(spec), { mode: 0o600 });
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const result = await runProcess(process.execPath, [worker, input], { cwd: root, env, timeoutMs: (options.timeoutMs ?? 60_000) * 2 + 90_000 });
  await writeFile(join(root, "worker.stderr.log"), result.stderr);
  try { return JSON.parse(await readFile(join(root, "report.json"), "utf8")); }
  catch { return { source: options.source, target: options.target, mode: options.mode, status: "fail", reason: `Worker produced no report (${result.code}, deadline=${result.timedOut})`, artifacts: [join(root, "worker.stderr.log")] }; }
}

async function main() {
  const args = process.argv.slice(2);
  let selected: CliName[] = CLI_CATALOG.map(cli => cli.id), source: CliName = "claude-code", mode: BridgeMode = "bootstrap";
  let output = join(tmpdir(), "turnbridge-installed-evidence"), cledger = process.env.TURNBRIDGE_VERIFY_CLEDGER, timeoutMs = 60_000, sourceFile: string | undefined, localModel: LocalModelConfig | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = args[++i];
    if (!value) throw Error(`Missing value for ${arg}`);
    if (arg === "--only") selected = value.split(",").map(value => { const name = parseCliName(value); if (!name) throw Error(`Unknown CLI ${value}`); return name; });
    else if (arg === "--source") { const name = parseCliName(value); if (!name) throw Error(`Unknown source ${value}`); source = name; }
    else if (arg === "--mode") { if (value !== "bootstrap" && value !== "native-import") throw Error("Mode must be bootstrap or native-import"); mode = value; }
    else if (arg === "--output") output = resolve(value);
    else if (arg === "--cledger") cledger = resolve(value);
    else if (arg === "--local-model") { localModel = JSON.parse(await readFile(value, "utf8")); validateLocalModel(localModel!); }
    else if (arg === "--provider-config") { localModel = JSON.parse(await readFile(value, "utf8")); validateInferenceProvider(localModel!); }
    else if (arg === "--source-file") sourceFile = resolve(value);
    else if (arg === "--timeout-ms") { timeoutMs = Number(value); if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw Error("Timeout must be 1000–180000 milliseconds"); }
    else throw Error(`Unknown option ${arg}`);
  }
  if (!cledger) throw Error("Supply --cledger /path/to/merged-cledger/dist/cli.js (or TURNBRIDGE_VERIFY_CLEDGER)");
  const reports = [];
  for (const target of selected) {
    if (source === target) continue;
    const binary = process.env[`TURNBRIDGE_VERIFY_${target.toUpperCase().replaceAll("-", "_")}_BINARY`];
    process.stderr.write(`Verifying ${source} → ${target} (${mode})\n`);
    const report = await runInstalledScenario({ source, target, mode, cledger, outputDirectory: output, timeoutMs, ...(localModel ? { localModel } : {}),
      ...(binary ? { binary } : {}), ...(sourceFile ? { sourceFile } : {}), ...((process.env.TURNBRIDGE_AIDER_PYTHON ?? process.env.TURNBRIDGE_VERIFY_AIDER_BINARY) ? { aiderPython: (process.env.TURNBRIDGE_AIDER_PYTHON ?? process.env.TURNBRIDGE_VERIFY_AIDER_BINARY)! } : {}) });
    reports.push(report);
    process.stderr.write(`[${report.status}] ${report.target}: ${report.reason || "all gates passed"}\n`);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "campaign.json"), JSON.stringify(reports, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  process.exitCode = reports.some(report => report.status === "fail") ? 1 : reports.some(report => report.status === "blocked") ? 2 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
