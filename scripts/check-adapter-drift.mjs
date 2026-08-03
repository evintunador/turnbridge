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
 *
 * `--fix` additionally widens each drifted adapter's prefix list in place and
 * writes `branch` + `bumped` outputs, so CI can open a mechanical draft PR.
 * This ONLY edits the pin — it validates nothing. The probes that would earn
 * that pin need both CLIs installed, a TTY, and paid model credentials for
 * each provider, none of which CI has. A human runs them and undrafts.
 */
import { readFile, writeFile, appendFile } from "node:fs/promises";

const FIX = process.argv.includes("--fix");

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

const PIN_RE = /VALIDATED_VERSION_PREFIX(?:ES)?\s*=\s*("[^"]+"|\[[^\]]+\])/;

async function pinnedPrefixes(adapterUrl) {
  const src = await readFile(adapterUrl, "utf8");
  // Single form: VALIDATED_VERSION_PREFIX = "2." — or array form:
  // VALIDATED_VERSION_PREFIXES = ["0.144.", "0.145."]
  const m = src.match(PIN_RE);
  if (!m) throw new Error(`no VALIDATED_VERSION_PREFIX(ES) in ${adapterUrl.pathname}`);
  const prefixes = m[1].match(/"([^"]+)"/g).map((q) => q.slice(1, -1));
  if (prefixes.length === 0) throw new Error(`empty prefix list in ${adapterUrl.pathname}`);
  return { prefixes, isList: m[1].startsWith("["), src, match: m[1] };
}

/**
 * The prefix that would cover `latest`, at the granularity the adapter already
 * pins at: "0.145." pins major.minor, "2." pins major, so 0.146.0 becomes
 * "0.146." and 3.0.1 would become "3.".
 */
function prefixFor(existing, latest) {
  const depth = existing.split(".").filter(Boolean).length;
  return `${latest.split(".").slice(0, depth).join(".")}.`;
}

/**
 * Widen a drifted adapter's pin in place. Only the array form is rewritten:
 * converting the single-string form to a list would break the `.startsWith`
 * call that reads it, and a target pinned at whole-major granularity has only
 * drifted because a new MAJOR shipped — which is never a one-line fix anyway.
 */
async function widen(adapterUrl, pin, latest) {
  const added = prefixFor(pin.prefixes[0], latest);
  if (!pin.isList) return { added, applied: false };
  const list = `[${[...pin.prefixes, added].map((p) => `"${p}"`).join(", ")}]`;
  await writeFile(adapterUrl, pin.src.replace(pin.match, list), "utf8");
  return { added, applied: true };
}

async function latestVersion(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${pkg}`);
  return (await res.json()).version;
}

const rows = [];
let drift = false;
for (const t of TARGETS) {
  const pin = await pinnedPrefixes(t.adapter);
  const latest = await latestVersion(t.npmPackage);
  const ok = pin.prefixes.some((p) => latest.startsWith(p));
  if (!ok) drift = true;
  const shown = pin.prefixes.map((p) => `${p}x`).join(", ");
  const fix = !ok && FIX ? await widen(t.adapter, pin, latest) : null;
  rows.push({ ...t, prefix: shown, latest, ok, fix });
  console.log(`${ok ? "OK   " : "DRIFT"} ${t.name}: latest ${latest} vs validated ${shown}`);
  if (fix?.applied) console.log(`      widened pin to include ${fix.added}x`);
  else if (fix) console.log(`      pin is a bare major ("${pin.prefixes[0]}") — widening needs a human`);
}

const drifted = rows.filter((r) => !r.ok);

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
    "A **draft** PR widening the pin is opened automatically, but CI cannot validate it —",
    "the probes need both CLIs installed, a TTY, and paid model credentials per provider.",
    "Revalidation is a local job for each drifted target:",
    "",
    "1. Install the new release, then re-verify the fabrication spec (`" +
      drifted.map((r) => r.spec).join("`, `") + "`) against a session it authored.",
    "2. Run `npm run smoke:interactive`, plus the headless probes in `scripts/` that touch the",
    "   drifted target (content recall, structured tool replay, large history).",
    "3. Record the evidence in the spec's revalidation log, then undraft the PR.",
    "",
    "If the format changed materially, close the PR — the writer needs amending, not the pin.",
  ].join("\n");
  const branch = drifted.length
    ? `adapter-drift/${drifted.map((r) => `${r.npmPackage.replace(/[@/]/g, "-").replace(/^-/, "")}-${r.latest}`).join("+")}`
    : "";
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `drift=${drift}\nbranch=${branch}\n` +
      `bumped=${drifted.some((r) => r.fix?.applied)}\n` +
      `report<<TB_EOF\n${report}\nTB_EOF\n`,
  );
}
process.exit(drift ? 2 : 0);
