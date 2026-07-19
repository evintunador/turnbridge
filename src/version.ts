import { readFileSync } from "node:fs";

/** turnbridge's own package version, for producer provenance. */
export function turnbridgeVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
