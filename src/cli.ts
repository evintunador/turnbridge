#!/usr/bin/env node
import { runRecordsCommand } from "annals";
import { asLedger, findRepo } from "conversation-ledger";
import { resumeCommand, type ResumeFlags } from "./resume.js";
import { shimInstall, shimStatus, shimUninstall } from "./shim.js";
import { parseCliName } from "./types.js";

const USAGE = `turnbridge — continue a coding-agent conversation in another CLI

Usage:
  turnbridge resume [claude|codex|opencode] [options]   pick a conversation and resume it
  turnbridge list [options]                            print compatible conversations
  turnbridge shim install|uninstall|status             opt-in \`claude --resume\` interception
  turnbridge records <command>                         maintain shared cledger records

Options for resume/list:
  --all         include collaborators' conversations (default: yours + unattributed)
  --any-commit  include conversations anchored to commits not reachable from HEAD
  --bootstrap   force honest rehydration (fresh session reads the transcript)
                instead of fabricating a native session file
  --no-reasoning-replay
                don't replay Codex-origin encrypted reasoning blobs when
                fabricating back into Codex (default: replay them)
`;

const RECORD_ALIASES = new Map([
  ["sync", "sync"],
  ["review", "review"],
  ["inspect", "inspect"],
  ["redact", "redact"],
  ["allow", "allow"],
  ["reanchor", "reanchor"],
  ["re-anchor", "reanchor"],
]);

async function recordsCommand(argv: string[]): Promise<number> {
  // cledger alone owns the pre-push hook ABI for this shared namespace.
  if (argv[0] === "transport-push") {
    process.stderr.write("turnbridge records: use cledger transport-push for the shared hook\n");
    return 2;
  }
  const repo = await findRepo(process.cwd());
  if (!repo) {
    process.stderr.write("turnbridge records: run inside a git repository\n");
    return 1;
  }
  return runRecordsCommand({
    ledger: asLedger(repo),
    argv,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    commandName: "turnbridge records",
  });
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  if (command === "records") return recordsCommand(args);
  const recordAlias = RECORD_ALIASES.get(command);
  if (recordAlias) return recordsCommand([recordAlias, ...args]);

  if (command === "resume" || command === "list") {
    const flags: ResumeFlags = { listOnly: command === "list" };
    for (const arg of args) {
      if (arg === "--all" || arg === "-a") flags.all = true;
      else if (arg === "--any-commit") flags.anyCommit = true;
      else if (arg === "--bootstrap") flags.bootstrap = true;
      else if (arg === "--no-reasoning-replay") flags.noReasoningReplay = true;
      else if (!arg.startsWith("-")) {
        const target = parseCliName(arg);
        if (!target) {
          process.stderr.write(`turnbridge: unknown target CLI: ${arg}\n`);
          return 1;
        }
        flags.target = target;
      } else {
        process.stderr.write(`turnbridge: unknown option: ${arg}\n`);
        return 1;
      }
    }
    return resumeCommand(flags);
  }

  if (command === "shim") {
    const sub = args.shift();
    if (sub === "install") return shimInstall();
    if (sub === "uninstall") return shimUninstall();
    if (sub === "status") return shimStatus();
    process.stderr.write("turnbridge: shim install|uninstall|status\n");
    return 1;
  }

  process.stderr.write(`turnbridge: unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`turnbridge: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
