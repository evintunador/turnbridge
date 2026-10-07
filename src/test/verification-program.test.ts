import assert from "node:assert/strict";
import test from "node:test";
import { bridgeEvidence, coreFailures } from "../verification/program.js";
import { requiredGates } from "../verification/matrix.js";

test("campaign promotion refuses fixture sources and incomplete or inexact evidence", () => {
  const report = { source: "pi", target: "codex", platform: "darwin", mode: "bootstrap", sourceVersion: "0.87.1", targetVersion: "0.159.0",
    tier: "scripted", terminal: "interactive", status: "pass", sourceProof: "installed-capture", observedAt: "2026-10-06T00:00:00Z",
    artifacts: ["terminal.log"], gates: Object.fromEntries(requiredGates("bootstrap").map(gate => [gate, true])) };
  assert(bridgeEvidence(report));
  assert.equal(bridgeEvidence({ ...report, sourceProof: "canonical-fixture" }), undefined);
  assert.equal(bridgeEvidence({ ...report, targetVersion: "unknown" }), undefined);
  assert.throws(() => bridgeEvidence({ ...report, gates: { lineage: true } }), /every required gate/);
});

test("CI requires every selected hub direction and mode, even when peripheral bridges pass", () => {
  const evidence = [] as Parameters<typeof coreFailures>[0];
  assert.equal(coreFailures(evidence, ["codex"], ["claude-code", "pi"]).length, 4);
  for (const [source, target] of [["codex", "claude-code"], ["claude-code", "codex"]] as const) for (const mode of ["native-import", "bootstrap"] as const) {
    evidence.push({ source, target, mode, status: "pass" } as typeof evidence[number]);
  }
  assert.deepEqual(coreFailures(evidence, ["codex"], ["claude-code", "pi"]), []);
  evidence.push({ source: "codex", target: "claude-code", mode: "bootstrap", status: "fail" } as typeof evidence[number]);
  assert.deepEqual(coreFailures(evidence, ["codex"], ["claude-code", "pi"]), ["codex->claude-code/bootstrap"]);
});
