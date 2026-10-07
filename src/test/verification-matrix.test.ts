import assert from "node:assert/strict";
import test from "node:test";
import { bridgeMatrix, scenarioKey, latestEvidence, requiredGates, validateEvidence, type BridgeEvidence } from "../verification/matrix.js";
import { buildReport } from "../verification/report.js";

function passing(overrides: Partial<BridgeEvidence> = {}): BridgeEvidence {
  return {
    sourceProof: "installed-capture", source: "qwen-code", target: "codex", platform: "linux", mode: "native-import",
    sourceVersion: "0.24.6", targetVersion: "0.159.0", tier: "scripted", terminal: "interactive",
    status: "pass", gates: Object.fromEntries(requiredGates("native-import").map(gate => [gate, true])),
    artifacts: ["fixture/terminal.log", "fixture/provider-requests.json", "fixture/ledger.json"],
    observedAt: "2026-10-06T00:00:00Z", ...overrides,
  };
}

test("hub matrix covers both directions and OSes without duplicate hub pairs", () => {
  const cells = bridgeMatrix();
  assert.equal(cells.length, 432); // 108 directed pairs × two OSes × two modes.
  assert.equal(new Set(cells.map(scenarioKey)).size, cells.length);
  assert(cells.some(cell => cell.source === "codex" && cell.target === "qwen-code"));
  assert(cells.some(cell => cell.source === "qwen-code" && cell.target === "codex"));
  assert(!cells.some(cell => cell.source === cell.target));
  assert(!cells.some(cell => cell.source === "pi" && cell.target === "goose"));
});

test("marker rendering alone cannot pass a bridge", () => {
  assert.throws(() => validateEvidence(passing({ gates: { historyRendering: true } })), /every required gate/);
  validateEvidence(passing());
  for (const gate of requiredGates("native-import")) {
    const run = passing();
    run.gates[gate] = false;
    assert.throws(() => validateEvidence(run), /every required gate/);
  }
});

test("bootstrap requires disclosure and continuation but not native scrollback", () => {
  const run = passing({ mode: "bootstrap", gates: Object.fromEntries(requiredGates("bootstrap").map(gate => [gate, true])) });
  validateEvidence(run);
  delete run.gates.bootstrapDisclosure;
  assert.throws(() => validateEvidence(run), /every required gate/);
});

test("new failures supersede old passes only in their exact version and inference cell", () => {
  const old = passing();
  const failed = passing({ status: "fail", reason: "resume lost context", observedAt: "2026-10-06T01:00:00Z" });
  const local = passing({ tier: "local-model" });
  const newerVersion = passing({ targetVersion: "0.160.0" });
  assert.deepEqual(latestEvidence([failed, old, local, newerVersion]), [failed, local, newerVersion]);
});

test("unverified versions, headless substitution and unexplained blockers are rejected", () => {
  assert.throws(() => validateEvidence(passing({ targetVersion: "0.159.x" })), /Exact CLI versions/);
  assert.throws(() => validateEvidence({ ...passing(), terminal: "headless" } as unknown as BridgeEvidence), /Headless/);
  assert.throws(() => validateEvidence(passing({ status: "blocked" })), /requires a reason/);
  validateEvidence(passing({ status: "blocked", reason: "login-required" }));
});

test("reports keep the full denominator and retain blockers separately from passes", () => {
  const report = buildReport([passing(), passing({ tier: "usual-provider", status: "blocked", reason: "login-required" })]);
  assert.equal(report.scenarios.length, 432);
  assert.equal(report.scenarios.filter(cell => cell.status === "not-run").length, 431);
  const tested = report.scenarios.find(cell => cell.evidence.length)!;
  assert.deepEqual(tested.evidence.map(run => run.status), ["pass", "blocked"]);
  assert.equal(tested.status, undefined);
  assert.throws(() => buildReport([passing({ artifacts: [] })]), /artifact references/);
});

test("canonical source fixtures cannot be promoted to bridge evidence", () => {
  assert.throws(() => validateEvidence({ ...passing(), sourceProof: "canonical-fixture" } as unknown as BridgeEvidence), /installed captured source/);
});

test("screen-reader evidence cannot supersede a standard UI failure or different source UI", () => {
  const failed = passing({ status: "fail", reason: "older history hidden", uiMode: "standard" });
  const accessible = passing({ uiMode: "screen-reader", observedAt: "2026-10-06T01:00:00Z" });
  const accessibleSource = passing({ sourceUiMode: "screen-reader" });
  const exported = passing({ uiMode: "native-export" });
  assert.equal(latestEvidence([failed, accessible, accessibleSource, exported]).length, 4);
  assert.throws(() => validateEvidence({ ...passing(), uiMode: "unknown" } as unknown as BridgeEvidence), /Unknown UI mode/);
});
