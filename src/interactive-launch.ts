import { spawn } from "node-pty";
import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { runLaunchPlan } from "./launch.js";
import type { LaunchPlan } from "./targets/types.js";

/** Native terminal handoff for CLIs without an interactive initial-prompt flag. */
export async function runInteractiveLaunchPlan(plan: LaunchPlan): Promise<number> {
  if (!plan.initialInput) return runLaunchPlan(plan);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("turnbridge: this target needs an interactive terminal to submit its bootstrap prompt\n");
    return 1;
  }
  for (const note of plan.notes) process.stderr.write(`turnbridge: ${note}\n`);
  const input = plan.initialInput;
  // Compile before spawning so a malformed adapter never leaves a native process behind.
  const readiness = new RegExp(input.readiness, "i");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: process.env as Record<string, string>,
      name: process.env.TERM ?? "xterm-256color", cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 });
  } catch (error) {
    process.stderr.write(`turnbridge: failed to launch ${plan.command}: ${String(error)}\n`);
    return 1;
  }
  return new Promise(resolve => {
    const wasRaw = process.stdin.isRaw;
    let output = "", submitted = false, pasted = false;
    let enterTimer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder("utf8");
    const onInput = (bytes: Buffer | string) => {
      // Once a person types, let them own the composer; do not race their input.
      // Folder trust happens before the composer. Forward that input without
      // cancelling the pending prompt; typing in the composer transfers ownership.
      if (!submitted && (pasted || readiness.test(stripVTControlCharacters(output)))) { submitted = true; clearTimeout(timer); clearTimeout(enterTimer); process.stderr.write(`\r\nturnbridge: bootstrap prompt was not submitted automatically; paste:\r\n${input.prompt}\r\n`); }
      child.write(typeof bytes === "string" ? bytes : decoder.write(bytes));
    };
    const resize = () => child.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    const terminate = () => child.kill();
    const timer = setTimeout(() => {
      if (!submitted) {
        submitted = true;
        process.stderr.write(`\r\nturnbridge: composer not detected; paste this prompt when ready:\r\n${input.prompt}\r\n`);
      }
    }, 60_000);
    child.onData(data => {
      process.stdout.write(data);
      output = (output + data).slice(-40_000);
      const plain = stripVTControlCharacters(output);
      if (!submitted && !pasted && readiness.test(plain)) {
        pasted = true;
        // Bracketed paste keeps a multiline prompt in the editor until one explicit Enter.
        child.write(input.paste === false ? input.prompt : "\x1b[200~" + input.prompt + "\x1b[201~");
        output = ""; // Only an echo after this paste establishes a composed prompt.
      } else if (!submitted && pasted && plain.includes(input.prompt.slice(0, 20))) {
        submitted = true; clearTimeout(timer);
        enterTimer = setTimeout(() => { try { child.write("\r"); } catch { /* exited */ } }, 250);
      }
    });
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onInput);
    process.stdout.on("resize", resize);
    process.on("SIGTERM", terminate);
    child.onExit(({ exitCode }) => {
      clearTimeout(timer); clearTimeout(enterTimer);
      process.stdin.removeListener("data", onInput);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      process.stdout.removeListener("resize", resize);
      process.removeListener("SIGTERM", terminate);
      resolve(exitCode);
    });
  });
}
