import { CLI_CATALOG } from "../cli-catalog.js";
import { bootstrapPrompt } from "../bootstrap.js";
import { binaryOnPath } from "../launch.js";
import { cliLabel, type CliName } from "../types.js";
import { dirname } from "node:path";
import { FabricationUnsupportedError, type LaunchPlan, type TargetAdapter } from "./types.js";

interface Syntax {
  start: (prompt: string) => string[];
  resume?: (id: string) => string[];
  readiness?: string;
  wrapper?: "continue" | "crush" | "kiro";
}

/** Native --help and cledger's merged installed drivers, not headless aliases. */
export const BOOTSTRAP_SYNTAX: Partial<Record<CliName, Syntax>> = {
  "gemini-cli": { start: prompt => ["--prompt-interactive", prompt], resume: id => ["--resume", id] },
  "qwen-code": { start: prompt => ["--prompt-interactive", prompt], resume: id => ["--resume", id] },
  copilot: { start: prompt => ["--interactive", prompt], resume: id => ["--resume", id] },
  cursor: { start: prompt => [prompt], resume: id => ["--resume", id] },
  kimi: { start: () => [], resume: id => ["--session", id], readiness: "shift-tab to Plan mode|context:.*\\(" },
  "mistral-vibe": { start: prompt => ["--legacy-harness", "--", prompt], resume: id => ["--legacy-harness", "--resume", id] },
  droid: { start: prompt => [prompt], resume: id => ["--resume", id] },
  kiro: { start: prompt => ["chat", prompt], resume: id => ["chat", "--resume-id", id], wrapper: "kiro" },
  pi: { start: prompt => ["--", prompt], resume: id => ["--session", id] },
  openhands: { start: prompt => ["--task", prompt], resume: id => ["--resume", id] },
  cline: { start: prompt => ["--tui", prompt], resume: id => ["--tui", "--id", id] },
  "open-interpreter": { start: prompt => [prompt], resume: id => ["resume", id] },
  goose: { start: () => ["session"], resume: id => ["session", "--resume", "--session-id", id, "--history"], readiness: "Enter to send" },
  // Aider's --message exits; send through its interactive editor instead.
  aider: { start: () => [], readiness: "(?:^|[\\r\\n])[^\\r\\n]*> " },
  continue: { start: prompt => [prompt], wrapper: "continue" },
  crush: { start: () => [], resume: id => ["--session", id], readiness: "Ready[!.?]|Ready for instructions", wrapper: "crush" },
  kilo: { start: prompt => ["--prompt", prompt], resume: id => ["--session", id] },
};

function wrap(name: CliName, binary: string, args: string[], cwd: string, notes: string[]): LaunchPlan {
  const syntax = BOOTSTRAP_SYNTAX[name]!;
  if (name === "aider") {
    // Python selection is explicit: pipx/venv Aider need their own interpreter.
    const python = process.env.TURNBRIDGE_AIDER_PYTHON;
    return { command: "cledger", args: ["run", "aider", ...(python ? ["--python", python] : []), "--", ...args], cwd,
      notes: [...notes, "Aider capture uses cledger's recorder; set TURNBRIDGE_AIDER_PYTHON to the Python environment containing aider-chat"] };
  }
  if (syntax.wrapper) return { command: "cledger", args: ["run", syntax.wrapper, "--binary", binary, "--", ...args], cwd, notes };
  return { command: binary, args, cwd, notes };
}

export function bootstrapTarget(name: CliName): TargetAdapter {
  const syntax = BOOTSTRAP_SYNTAX[name];
  const binary = CLI_CATALOG.find(cli => cli.id === name)!.command;
  if (!syntax) throw Error(`No bootstrap syntax for ${name}`);
  return {
    name, binary, supportsNativeResume: !!syntax.resume, supportsNativeImport: false,
    async isInstalled() {
      if (name === "aider" && process.env.TURNBRIDGE_AIDER_PYTHON) return (await binaryOnPath(process.env.TURNBRIDGE_AIDER_PYTHON)) && (await binaryOnPath("cledger"));
      return (await binaryOnPath(binary)) && (!(syntax.wrapper || name === "aider") || await binaryOnPath("cledger"));
    },
    nativeResume(id, cwd) {
      if (!syntax.resume) throw new FabricationUnsupportedError(`${cliLabel(name)} has no verified exact-ID resume route; use transcript bootstrap`, name);
      return wrap(name, binary, syntax.resume(id), cwd, [`resuming native ${cliLabel(name)} session ${id}`]);
    },
    async fabricate() {
      throw new FabricationUnsupportedError(`${cliLabel(name)} native history import is not implemented`, name);
    },
    bootstrap(summary, cwd, transcriptPath) {
      const prompt = bootstrapPrompt(summary, transcriptPath);
      const args = syntax.start(prompt);
      if (name === "aider") args.push("--read", transcriptPath);
      if (name === "gemini-cli" || name === "qwen-code") args.unshift("--include-directories", dirname(transcriptPath));
      if (name === "copilot") args.unshift("--add-dir", dirname(transcriptPath));
      const plan = wrap(name, binary, args, cwd, [
        `starting a NEW ${cliLabel(name)} session rehydrated from ${cliLabel(summary.source)} (bootstrap mode)`,
        `transcript: ${transcriptPath}`, "bootstrap does not insert the imported history into native scrollback",
      ]);
      if (syntax.readiness) plan.initialInput = { prompt, readiness: syntax.readiness, ...(name === "aider" ? { paste: false } : {}) };
      return plan;
    },
  };
}
