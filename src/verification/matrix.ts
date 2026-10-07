import { TARGET_CLIS } from "./roster.js";

export const HUBS = ["claude-code", "codex", "opencode"] as const;
export type BridgeMode = "native-import" | "bootstrap";
export type Platform = "darwin" | "linux";
export type InferenceTier = "scripted" | "local-model" | "usual-provider";
export type UiMode = "standard" | "screen-reader" | "native-export";

export interface BridgeScenario {
  source: string;
  target: string;
  platform: Platform;
  mode: BridgeMode;
}

/** Both directions through each hub, deduplicated; same-CLI resume is a gate. */
export function bridgeMatrix(): BridgeScenario[] {
  return TARGET_CLIS.flatMap(source => TARGET_CLIS.flatMap(target => {
    if (source.id === target.id || ![source.id, target.id].some(id => HUBS.some(hub => hub === id))) return [];
    return (["darwin", "linux"] as const).flatMap(platform =>
      (["native-import", "bootstrap"] as const).map(mode => ({ source: source.id, target: target.id, platform, mode })));
  }));
}

export const COMMON_GATES = [
  "modelContext", "newToolUse", "automaticCapture", "lineage", "subsequentResume", "normalExit",
] as const;
export type Gate = typeof COMMON_GATES[number] | "historyRendering" | "bootstrapDisclosure";

export function requiredGates(mode: BridgeMode): readonly Gate[] {
  return [...COMMON_GATES, mode === "native-import" ? "historyRendering" : "bootstrapDisclosure"];
}

/** One installed-binary run. Exact versions and inference tiers never substitute for one another. */
export interface BridgeEvidence extends BridgeScenario {
  sourceVersion: string;
  targetVersion: string;
  tier: InferenceTier;
  uiMode?: UiMode;
  sourceUiMode?: UiMode;
  terminal: "interactive";
  sourceProof: "installed-capture";
  status: "pass" | "fail" | "blocked" | "unsupported";
  gates: Partial<Record<Gate, boolean>>;
  artifacts: string[];
  observedAt: string;
  reason?: string;
}

export function validateEvidence(evidence: BridgeEvidence): void {
  const ids = new Set<string>(TARGET_CLIS.map(cli => cli.id));
  if (!ids.has(evidence.source) || !ids.has(evidence.target)) throw Error("Unknown CLI in bridge evidence");
  if (!bridgeMatrix().some(cell => scenarioKey(cell) === scenarioKey(evidence))) throw Error("Evidence is outside the hub matrix");
  if (evidence.sourceProof !== "installed-capture") throw Error("Bridge evidence requires an installed captured source");
  if (evidence.terminal !== "interactive") throw Error("Headless evidence cannot qualify an interactive bridge");
  if (!["scripted", "local-model", "usual-provider"].includes(evidence.tier)) throw Error("Unknown inference tier");
  for (const mode of [evidence.uiMode, evidence.sourceUiMode]) if (mode !== undefined && !["standard", "screen-reader", "native-export"].includes(mode)) throw Error("Unknown UI mode");
  if (!["pass", "fail", "blocked", "unsupported"].includes(evidence.status)) throw Error("Unknown evidence status");
  if (![evidence.sourceVersion, evidence.targetVersion].every(v => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v))) throw Error("Exact CLI versions are required");
  if (!Number.isFinite(Date.parse(evidence.observedAt))) throw Error("Evidence requires an observation timestamp");
  if (!Array.isArray(evidence.artifacts) || !evidence.artifacts.length || evidence.artifacts.some(path => typeof path !== "string" || !path.trim())) throw Error("Evidence requires artifact references");
  if (evidence.status === "pass" && requiredGates(evidence.mode).some(gate => evidence.gates?.[gate] !== true)) throw Error("Passing evidence must satisfy every required gate");
  if (evidence.status !== "pass" && !evidence.reason?.trim()) throw Error("Failed or blocked evidence requires a reason");
}

export function scenarioKey(scenario: BridgeScenario): string {
  return `${scenario.source}->${scenario.target}/${scenario.platform}/${scenario.mode}`;
}

/** Reports use an exact version pair, OS, mode and tier; no broader support inference. */
export function evidenceKey(evidence: BridgeEvidence): string {
  return `${scenarioKey(evidence)}/${evidence.sourceVersion}/${evidence.targetVersion}/${evidence.tier}/${evidence.sourceUiMode ?? "standard"}/${evidence.uiMode ?? "standard"}`;
}

export function latestEvidence(runs: readonly BridgeEvidence[]): BridgeEvidence[] {
  const latest = new Map<string, BridgeEvidence>();
  for (const run of runs) {
    validateEvidence(run);
    const key = evidenceKey(run), previous = latest.get(key);
    if (!previous || Date.parse(run.observedAt) >= Date.parse(previous.observedAt)) latest.set(key, run);
  }
  return [...latest.values()];
}
