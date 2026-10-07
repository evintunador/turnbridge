#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const pins = JSON.parse(await readFile(new URL("../verification/runtimes.json", import.meta.url), "utf8"));
const releases = [];
for (const pin of pins.npm) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pin.package)}/latest`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`${pin.package}: registry ${response.status}`);
  const latest = await response.json();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(latest.version)) throw Error("Registry did not return an exact version");
  if (latest.version !== pin.version) releases.push({ cli: pin.cli, package: pin.package, current: pin.version, candidate: latest.version, integrity: latest.dist?.integrity });
}
const proposal = { schema: "turnbridge-candidates/1", observedAt: new Date().toISOString(), foundation: pins.cledger, releases,
  status: "review-required", requirements: ["exact candidate versions", "macOS and Linux installed bridge evidence", "no regression in previously passing routes", "maintainer review before changing pins"],
  exclusions: ["no automatic pin promotion", "no paid provider credentials", "native/Python release discovery requires separate checksum/lock review"] };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(proposal, null, 2) + "\n");
else process.stdout.write(JSON.stringify(proposal, null, 2) + "\n");
