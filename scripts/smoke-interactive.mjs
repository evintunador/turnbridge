#!/usr/bin/env node
/**
 * Interactive-resume smoke test: fabricates a session from a planted-marker
 * conversation, launches the target CLI's real interactive TUI under a pty,
 * and asserts the imported history actually renders on screen before quitting
 * (no prompt is ever sent, so no model call is made).
 *
 * This covers what the headless verification (`claude -p`, `codex exec`)
 * cannot: the TUI render path users actually see. See docs/specs/* "Unknowns".
 *
 * Usage: node scripts/smoke-interactive.mjs [claude-code|codex|opencode|all] [--manual]
 * Env:   SMOKE_KEEP=1 keeps the temp repo and fabricated session files.
 * Artifacts (raw + ANSI-stripped pty captures) land in a temp dir printed at
 * the end — review the stripped capture for visual glitches by eye too.
 *
 * --manual: fabricate the sessions but launch nothing — print the exact
 * commands to run in a normal terminal so a human can judge the TUI render
 * (stripped pty captures cannot prove the screen *looked* right; the Codex
 * empty-scrollback bug was exactly this class of failure). Keeps everything.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvents, findRepo, git } from "conversation-ledger";
import { listConversations, targetFor } from "../dist/index.js";

const RUN_ID = Math.random().toString(36).slice(2, 8);
const USER_MARKER = `TB-SMOKE-USER-${RUN_ID}`;
const ASSISTANT_MARKER = `TB-SMOKE-ASSISTANT-${RUN_ID}`;
const KEEP = process.env.SMOKE_KEEP === "1";

const stripAnsi = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-_]/g, "") // bare escapes
    .replace(/\r/g, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeSeededRepo(artifactsDir) {
  const dir = await mkdtemp(join(tmpdir(), "turnbridge-smoke-"));
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  await git(["config", "user.email", "smoke@turnbridge.test"], { cwd: dir });
  await git(["config", "user.name", "Turnbridge Smoke"], { cwd: dir });
  await git(["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "turnbridge interactive smoke test repo\n");
  await git(["add", "."], { cwd: dir });
  await git(["commit", "-q", "-m", "init"], { cwd: dir });
  const repo = await findRepo(dir);
  if (!repo) throw new Error("failed to init smoke repo");

  const conversationId = `claude-code:${crypto.randomUUID()}`;
  const turn = (role, text, seq, blocks) => ({
    kind: "conversation_turn",
    occurred_at: `2026-01-01T00:00:0${seq}.000Z`,
    actor:
      role === "user"
        ? { type: "human", id: "smoke@turnbridge.test" }
        : { type: "agent", id: "smoke-model" },
    producer: {
      tool: "turnbridge-smoke",
      source: "claude-code",
      session_id: conversationId.split(":")[1],
    },
    conversation: { id: conversationId, seq },
    content: { role, blocks: blocks ?? [{ type: "text", text }] },
  });
  await appendEvents(repo, [
    turn("user", `${USER_MARKER}: please remember this exact marker phrase.`, 0),
    turn(
      "assistant",
      `Understood — the marker is ${ASSISTANT_MARKER} and I will recall it on request.`,
      1,
    ),
    // Rendering-shape coverage for human inspection: multi-line text with a
    // list and a code fence, and an assistant turn with a thinking block
    // (folds to labeled text during fabrication).
    turn(
      "user",
      [
        "Second check — does structured text survive the bridge visually?",
        "- bullet one",
        "- bullet two",
        "",
        "```js",
        'console.log("fenced code block");',
        "```",
      ].join("\n"),
      2,
    ),
    turn("assistant", null, 3, [
      { type: "thinking", text: "A short thinking block that fabrication folds into labeled text." },
      {
        type: "text",
        text: "Multi-line reply:\n1. numbered item\n2. another item\n\nAnd a closing paragraph.",
      },
    ]),
  ]);
  await writeFile(join(artifactsDir, "repo-path.txt"), dir + "\n");
  return { repo, conversationId };
}

/**
 * Run `command` in a real pty via scripts/pty-run.exp (macOS `script` needs a
 * tty on stdin; expect does not). The runner logs all terminal output,
 * auto-accepts a trust prompt, waits `settleSeconds`, then quits the TUI.
 * Returns the ANSI-stripped capture.
 */
async function runInPty({ command, args, cwd, logPath, settleSeconds }) {
  const runner = new URL("./pty-run.exp", import.meta.url).pathname;
  // Scrub CLI-session env the harness itself may run under (e.g. a claude
  // spawned from inside Claude Code inherits CLAUDE_CODE_CHILD_SESSION and
  // silently changes behavior) — test what a user's fresh shell would see.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(CLAUDE|CLAUDECODE|CODEX)/.test(k),
    ),
  );
  const exitCode = await new Promise((resolve) => {
    const child = spawn("expect", [runner, logPath, String(settleSeconds), command, ...args], {
      cwd,
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  const stripped = stripAnsi(await readFile(logPath, "utf8").catch(() => ""));
  return { stripped, earlyExit: exitCode === 3 };
}

const GLITCH_PATTERNS = [
  [/\[object Object\]/, "stringified object leaked into render"],
  [/\bundefined\b/, "literal 'undefined' rendered"],
  [/"parentUuid"|"session_meta"|"response_item"/, "raw session JSON leaked into render"],
  [/No such session|session not found|failed to load/i, "session lookup failure"],
  [/panicked|stack backtrace|Traceback/i, "target CLI crashed"],
];

async function smokeTarget(name, repo, conversationId, artifactsDir) {
  const target = targetFor(name);
  if (!(await target.isInstalled())) {
    return { name, status: "skip", detail: `${target.binary} not on PATH` };
  }
  // Select by id: capture hooks installed on this machine may have already
  // recorded the previous target's smoke session as a newer conversation.
  const summary = (await listConversations(repo, { all: true })).find(
    (c) => c.id === conversationId,
  );
  if (!summary) throw new Error("seeded conversation not visible to listConversations");

  const plan = await target.fabricate(summary, repo.root, { replayReasoning: true });
  const logPath = join(artifactsDir, `${name}.pty.log`);

  const { stripped, earlyExit } = await runInPty({
    command: plan.command,
    args: plan.args,
    cwd: repo.root,
    logPath,
    settleSeconds: 20,
  });
  await writeFile(join(artifactsDir, `${name}.stripped.txt`), stripped);

  // opencode fabrication imports into one shared SQLite DB rather than writing
  // a throwaway session file, so a smoke run leaves a row in the user's real
  // session list unless it cleans up after itself.
  if (name === "opencode" && !KEEP) {
    const sessionId = plan.args[plan.args.indexOf("-s") + 1];
    await new Promise((resolve) => {
      const child = spawn("opencode", ["session", "delete", sessionId], { stdio: "ignore" });
      child.on("close", resolve);
      child.on("error", resolve);
    });
  }

  // Success: both planted markers visible in the rendered scrollback.
  const satisfied = stripped.includes(USER_MARKER) && stripped.includes(ASSISTANT_MARKER);
  const glitches = [];
  for (const [re, label] of GLITCH_PATTERNS) {
    const m = stripped.match(re);
    if (m) glitches.push(`${label} (matched: ${JSON.stringify(m[0])})`);
  }
  return {
    name,
    status: satisfied ? "pass" : "fail",
    detail: satisfied
      ? "both markers rendered in the interactive TUI"
      : earlyExit
        ? "TUI exited before the settle window ended (see capture)"
        : "markers never appeared in TUI render before timeout",
    glitches,
    sessionNote: plan.notes.find((n) => n.includes("session") || n.includes("rollout")) ?? "",
  };
}

const argv = process.argv.slice(2);
const manual = argv.includes("--manual");
const pick = argv.find((a) => !a.startsWith("--")) ?? "all";
const names = pick === "all" ? ["claude-code", "codex", "opencode"] : [pick];
const artifactsDir = await mkdtemp(join(tmpdir(), "turnbridge-smoke-artifacts-"));
await mkdir(artifactsDir, { recursive: true });
const { repo, conversationId } = await makeSeededRepo(artifactsDir);

if (manual) {
  const out = [];
  out.push("", "Manual TUI inspection — sessions fabricated, nothing launched.", "");
  for (const name of names) {
    const target = targetFor(name);
    if (!(await target.isInstalled())) {
      out.push(`[skip] ${name}: ${target.binary} not on PATH`, "");
      continue;
    }
    const summary = (await listConversations(repo, { all: true })).find(
      (c) => c.id === conversationId,
    );
    const plan = await target.fabricate(summary, repo.root, { replayReasoning: true });
    out.push(
      `[${name}] run this in a normal terminal (not inside another agent session):`,
      "",
      `    cd ${repo.root} && ${plan.command} ${plan.args.join(" ")}`,
      "",
      ...plan.notes.map((n) => `    note: ${n}`),
      "",
    );
  }
  out.push(
    "What to check on screen:",
    `  1. The import notice renders as the first message.`,
    `  2. All four turns are visible in the scrollback — user marker "${USER_MARKER}",`,
    `     assistant marker "${ASSISTANT_MARKER}", the bullets/code-fence turn, and the`,
    `     "[visible thinking]" + numbered-list turn. (Past bug: model saw the context`,
    `     but the TUI scrollback rendered empty.)`,
    "  3. No mangled spacing/wrapping, stray JSON, or escape-code artifacts.",
    "  4. Quit without sending a prompt (Ctrl+C twice) — or send one to verify recall.",
    "",
    `Repo and sessions are kept. Temp repo: ${repo.root}`,
    "",
  );
  process.stderr.write(out.join("\n"));
  process.exit(0);
}

const results = [];
for (const name of names) {
  process.stderr.write(`--- smoke: ${name} interactive resume ---\n`);
  try {
    results.push(await smokeTarget(name, repo, conversationId, artifactsDir));
  } catch (err) {
    results.push({ name, status: "error", detail: err instanceof Error ? err.message : String(err) });
  }
}

if (!KEEP) await rm(repo.root, { recursive: true, force: true });

let failed = false;
for (const r of results) {
  const line = `[${r.status.toUpperCase()}] ${r.name}: ${r.detail}`;
  process.stderr.write(line + "\n");
  if (r.sessionNote) process.stderr.write(`       ${r.sessionNote}\n`);
  for (const g of r.glitches ?? []) process.stderr.write(`       glitch? ${g}\n`);
  if (r.status === "fail" || r.status === "error") failed = true;
}
process.stderr.write(`artifacts: ${artifactsDir}\n`);
process.exit(failed ? 1 : 0);
