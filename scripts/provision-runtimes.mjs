#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const [foundation, directory, candidatesFile] = process.argv.slice(2);
if (!foundation || !directory) throw Error("Usage: provision-runtimes.mjs CLEAN_CLEDGER_ROOT RUNTIME_DIRECTORY [CANDIDATES_JSON]");
const pins = JSON.parse(await readFile(new URL("../verification/runtimes.json", import.meta.url), "utf8"));
const candidates = candidatesFile ? JSON.parse(await readFile(candidatesFile, "utf8")).releases : [];
// Tooling is pinned to an audited source checkout, never the contributor's installed package internals.
const { provisionRuntimes } = await import(pathToFileURL(join(resolve(foundation), "dist/verification/runtimes.js")));
const versions = Object.fromEntries(pins.npm.map(pin => [pin.cli, candidates.find(candidate => candidate.cli === pin.cli)?.candidate ?? pin.version]));
await provisionRuntimes(resolve(directory), pins.npm.map(pin => pin.cli), versions);
await writeFile(join(resolve(directory), "foundation.json"), JSON.stringify({ cledger: pins.cledger, annals: pins.annals, candidate: !!candidatesFile }, null, 2));
