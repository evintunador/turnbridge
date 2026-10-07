// node-pty's published Darwin prebuild includes a non-executable spawn-helper.
// Repair only this dependency's packaged helper, including source-built installs.
import { createRequire } from "node:module";
import { chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
if (process.platform === "darwin") {
  const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  for (const path of [join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), join(root, "build", "Release", "spawn-helper")]) {
    try { const info = await stat(path); if (info.isFile()) await chmod(path, info.mode | 0o111); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
