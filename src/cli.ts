#!/usr/bin/env node
import { resumeCommand, type ResumeFlags } from "./resume.js";
import { shimInstall, shimStatus, shimUninstall } from "./shim.js";
import { parseCliName } from "./types.js";

const USAGE = `turnbridge — continue a coding-agent conversation in another CLI

Usage:
  turnbridge resume [claude|codex] [options]   pick a conversation and resume it
  turnbridge list [options]                    print compatible conversations
  turnbridge shim install|uninstall|status     opt-in \`claude --resume\` interception

Options for resume/list:
  --all         include collaborators' conversations (default: yours + unattributed)
  --any-commit  include conversations anchored to commits not reachable from HEAD
  --bootstrap   force honest rehydration (fresh session reads the transcript)
                instead of fabricating a native session file
`;

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  if (command === "resume" || command === "list") {
    const flags: ResumeFlags = { listOnly: command === "list" };
    for (const arg of args) {
      if (arg === "--all" || arg === "-a") flags.all = true;
      else if (arg === "--any-commit") flags.anyCommit = true;
      else if (arg === "--bootstrap") flags.bootstrap = true;
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
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`turnbridge: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
