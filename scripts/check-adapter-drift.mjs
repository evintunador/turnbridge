#!/usr/bin/env node
/**
 * Adapter drift check: compares each target CLI's latest npm release against
 * the VALIDATED_VERSION_PREFIX pinned in its adapter. Fabrication specs are
 * reverse-engineered and version-pinned (docs/specs/), so a release outside
 * the validated prefix means the adapter needs revalidation.
 *
 * Exit codes: 0 = all validated, 2 = drift detected, 1 = check itself failed.
 * In GitHub Actions, also writes `drift` (true/false) and a markdown `report`
 * to $GITHUB_OUTPUT for downstream issue/PR steps.
 */
import { readFile, appendFile } from "node:fs/promises";

const TARGETS = [
  {
    name: "Claude Code",
    adapter: new URL("../src/targets/claude-code.ts", import.meta.url),
    npmPackage: "@anthropic-ai/claude-code",
    spec: "docs/specs/claude-session-format.md",
  },
  {
    name: "Codex",
    adapter: new URL("../src/targets/codex.ts", import.meta.url),
    npmPackage: "@openai/codex",
    spec: "docs/specs/codex-rollout-format.md",
  },
];

async function pinnedPrefixes(adapterUrl) {
  const src = await readFile(adapterUrl, "utf8");
  // Single form: VALIDATED_VERSION_PREFIX = "2." — or array form:
  // VALIDATED_VERSION_PREFIXES = ["0.144.", "0.145."]
  const m = src.match(/VALIDATED_VERSION_PREFIX(?:ES)?\s*=\s*("[^"]+"|\[[^\]]+\])/);
  if (!m) throw new Error(`no VALIDATED_VERSION_PREFIX(ES) in ${adapterUrl.pathname}`);
  const prefixes = m[1].match(/"([^"]+)"/g).map((q) => q.slice(1, -1));
  if (prefixes.length === 0) throw new Error(`empty prefix list in ${adapterUrl.pathname}`);
  return prefixes;
}

async function latestVersion(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${pkg}`);
  return (await res.json()).version;
}

const rows = [];
let drift = false;
for (const t of TARGETS) {
  const prefixes = await pinnedPrefixes(t.adapter);
  const latest = await latestVersion(t.npmPackage);
  const ok = prefixes.some((p) => latest.startsWith(p));
  if (!ok) drift = true;
  const shown = prefixes.map((p) => `${p}x`).join(", ");
  rows.push({ ...t, prefix: shown, latest, ok });
  console.log(`${ok ? "OK   " : "DRIFT"} ${t.name}: latest ${latest} vs validated ${shown}`);
}

if (process.env.GITHUB_OUTPUT) {
  const report = [
    "Latest CLI releases have moved outside the version prefixes the fabrication adapters were validated against.",
    "",
    "| Target | Validated prefix | Latest release | Status |",
    "|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.name} (\`${r.npmPackage}\`) | \`${r.prefix}\` | \`${r.latest}\` | ${r.ok ? "validated" : "**drift**"} |`,
    ),
    "",
    "Revalidation is a local job — CI cannot do it (see the workflow's header comment).",
    "Steps for each drifted target:",
    "1. Install the new release, then re-verify the fabrication spec (`" +
      rows.filter((r) => !r.ok).map((r) => r.spec).join("`, `") + "`) against a session it authored.",
    "2. Run `npm run smoke:interactive`, plus the headless probes in `scripts/` that touch the",
    "   drifted target (content recall, structured tool replay, large history).",
    "3. Widen `VALIDATED_VERSION_PREFIX` (or amend the writer) in the adapter, and record the",
    "   evidence in the spec's revalidation log.",
  ].join("\n");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `drift=${drift}\nreport<<TB_EOF\n${report}\nTB_EOF\n`,
  );
}
process.exit(drift ? 2 : 0);
