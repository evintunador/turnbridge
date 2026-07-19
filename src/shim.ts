import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { configDir } from "./config.js";

const RC_MARKER = "# added by `turnbridge shim install`";

export function shimDir(): string {
  return join(configDir(), "shims");
}

/** Real binary path, skipping our own shim directory. */
function resolveRealBinary(binary: string): string | null {
  const result = spawnSync("which", ["-a", binary], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const paths = result.stdout.split("\n").filter(Boolean);
  return paths.find((p) => !p.startsWith(shimDir())) ?? null;
}

function claudeShim(realPath: string): string {
  return `#!/bin/sh
${RC_MARKER}
# Bare \`claude --resume\` opens the turnbridge merged picker; everything else
# passes through to the real binary.
if [ "$#" -eq 1 ] && { [ "$1" = "--resume" ] || [ "$1" = "-r" ]; }; then
  exec turnbridge resume claude-code
fi
exec "${realPath}" "$@"
`;
}

function codexShim(realPath: string): string {
  return `#!/bin/sh
${RC_MARKER}
# Bare \`codex resume\` opens the turnbridge merged picker; everything else
# passes through to the real binary.
if [ "$#" -eq 1 ] && [ "$1" = "resume" ]; then
  exec turnbridge resume codex
fi
exec "${realPath}" "$@"
`;
}

function rcPath(): string {
  return join(homedir(), ".zshrc");
}

async function rcHasShimPath(): Promise<boolean> {
  try {
    return (await readFile(rcPath(), "utf8")).includes(RC_MARKER);
  } catch {
    return false;
  }
}

export async function shimInstall(): Promise<number> {
  const dir = shimDir();
  await mkdir(dir, { recursive: true });

  let wrote = 0;
  for (const [binary, template] of [
    ["claude", claudeShim],
    ["codex", codexShim],
  ] as const) {
    const real = resolveRealBinary(binary);
    if (!real) {
      process.stderr.write(`turnbridge: ${binary} not found on PATH; skipping its shim\n`);
      continue;
    }
    const path = join(dir, binary);
    await writeFile(path, template(real));
    await chmod(path, 0o755);
    process.stderr.write(`turnbridge: shim written: ${path} -> ${real}\n`);
    wrote++;
  }
  if (wrote === 0) return 1;

  if (await rcHasShimPath()) {
    process.stderr.write("turnbridge: PATH entry already present in ~/.zshrc\n");
  } else {
    const line = `\n${RC_MARKER}\nexport PATH="${dir}:$PATH"\n`;
    await writeFile(rcPath(), line, { flag: "a" });
    process.stderr.write(
      "turnbridge: added shim dir to PATH in ~/.zshrc — restart your shell or `source ~/.zshrc`\n",
    );
  }
  return 0;
}

export async function shimUninstall(): Promise<number> {
  await rm(shimDir(), { recursive: true, force: true });
  try {
    const rc = await readFile(rcPath(), "utf8");
    const cleaned = rc
      .split("\n")
      .filter((line, i, lines) => line !== RC_MARKER && lines[i - 1] !== RC_MARKER)
      .join("\n");
    if (cleaned !== rc) await writeFile(rcPath(), cleaned);
  } catch {
    // no rc file — nothing to clean
  }
  process.stderr.write("turnbridge: shims removed\n");
  return 0;
}

export async function shimStatus(): Promise<number> {
  const active = await rcHasShimPath();
  process.stdout.write(`shim dir: ${shimDir()}\n`);
  process.stdout.write(`PATH entry in ~/.zshrc: ${active ? "present" : "absent"}\n`);
  return 0;
}
