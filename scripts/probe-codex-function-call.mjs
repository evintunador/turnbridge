// Resolves docs/specs/codex-rollout-format.md §8.2: is it safe to replay a
// foreign tool call as a real `function_call`/`function_call_output` pair
// instead of folding it into labeled message text?
//
// This matters because the two directions are currently asymmetric. cledger
// captures structured tool history, and Codex→Claude keeps it (Claude accepts
// foreign tool_use names verbatim), but Claude→Codex flattens every tool call
// to `[used tool: Edit]\ninput: {...}` — not for lack of data, but because the
// spec could only verify plain `message` items as replay-safe.
//
// The specific hazard the spec names: a `function_call` whose `name` is a tool
// the target has never registered (every Claude tool, from Codex's point of
// view), and an orphaned `function_call_output` with no matching call. Both go
// to the API as history on the next turn.
//
// Usage: node scripts/probe-codex-function-call.mjs [variant ...]
// Each variant costs one real `codex exec` turn. Cleans up what it writes.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MARKER = `TB-FC-${Math.random().toString(36).slice(2, 8)}`;
const TOOL_NAME = "Edit"; // a Claude tool; Codex has no such tool registered
const PROMPT =
  "Two questions, answered on one line each: (1) reply with the secret marker phrase from " +
  "earlier in this conversation; (2) name the tool that was called earlier in this conversation.";

const sessionsDir = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");

const p = (n, w = 2) => String(n).padStart(w, "0");
function rolloutPath(now, id) {
  const datePath = join(String(now.getFullYear()), p(now.getMonth() + 1), p(now.getDate()));
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  return { dir: join(sessionsDir(), datePath), name: `rollout-${stamp}-${id}.jsonl` };
}

const TS = "2026-07-21T06:36:04.414Z";
const item = (payload) => ({ timestamp: TS, type: "response_item", payload });
const message = (role, text) =>
  item({
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  });

const CALL_ID = "call_TBPROBE0000000000000001";
const functionCall = () =>
  item({
    type: "function_call",
    id: "fc_tbprobe0000000000000001",
    name: TOOL_NAME,
    arguments: JSON.stringify({ file_path: "/tmp/notes.txt", old_string: "a", new_string: "b" }),
    call_id: CALL_ID,
  });
const functionCallOutput = (callId = CALL_ID) =>
  item({
    type: "function_call_output",
    call_id: callId,
    output: [{ type: "input_text", text: "Applied 1 edit to /tmp/notes.txt" }],
  });

/** Body lines after session_meta, per variant. */
const VARIANTS = {
  // Control: exactly what turnbridge writes today.
  "text-folded": () => [
    message("user", `The secret marker phrase is ${MARKER}. Remember it.`),
    message("assistant", `[used tool: ${TOOL_NAME}]\ninput: {"file_path":"/tmp/notes.txt"}\n[tool result]\nApplied 1 edit`),
  ],

  // The candidate: a well-formed pair whose `name` is foreign to Codex.
  "paired-foreign": () => [
    message("user", `The secret marker phrase is ${MARKER}. Remember it.`),
    functionCall(),
    functionCallOutput(),
    message("assistant", "I made that edit."),
  ],

  // The spec's named hazard: output with no matching call.
  "orphan-output": () => [
    message("user", `The secret marker phrase is ${MARKER}. Remember it.`),
    functionCallOutput("call_TBPROBE_NO_SUCH_CALL"),
    message("assistant", "I made that edit."),
  ],
};

const requested = process.argv.slice(2);
// "e2e" is handled after the variant loop, not by it
const names = (requested.length ? requested : Object.keys(VARIANTS)).filter((n) => n !== "e2e");

const cwd = await mkdtemp(join(tmpdir(), "turnbridge-fc-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE|CODEX_[A-Z])/.test(k)),
);
const written = [];
const results = [];

for (const name of names) {
  const build = VARIANTS[name];
  if (!build) {
    console.error(`unknown variant: ${name}`);
    continue;
  }
  const now = new Date();
  const id = crypto.randomUUID();
  const { dir, name: file } = rolloutPath(now, id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  const lines = [
    {
      timestamp: TS,
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        timestamp: TS,
        cwd,
        originator: "codex-tui",
        cli_version: "0.145.0",
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
        history_mode: "legacy",
      },
    },
    ...build(),
  ];
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  written.push(path);

  const run = spawnSync("codex", ["exec", "--skip-git-repo-check", "resume", id, PROMPT], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 180_000,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const recalled = out.includes(MARKER);
  const sawTool = out.includes(TOOL_NAME);
  // An API-level rejection of the fabricated history shows up here, not as a
  // parse error — that is the failure mode §8.2 warns about.
  const errored = run.status !== 0 || /\berror\b/i.test(out);
  results.push({ name, exit: run.status, recalled, sawTool, errored, out });
  console.log(
    `${name}: exit=${run.status} marker=${recalled} tool_named=${sawTool} error_text=${errored}`,
  );
}

console.log("\n--- results ---");
for (const r of results) {
  const verdict = r.recalled && !r.errored ? "USABLE" : "BROKEN";
  console.log(`${r.name.padEnd(16)} ${verdict}  exit=${r.exit} marker=${r.recalled} tool_named=${r.sawTool}`);
  if (!r.recalled || r.errored) {
    console.log(`  tail: ${r.out.trim().split("\n").slice(-4).join("\n        ")}`);
  }
}

// End-to-end: the variants above prove Codex *accepts* the format, and the
// unit tests prove turnbridge *emits* it. This proves the actual pipeline —
// ledger events with tool blocks, through turnbridge's own fabricate(), into a
// live resume — which is the only claim that covers both at once.
if (!requested.length || requested.includes("e2e")) {
  const { appendEvents, findRepo, git } = await import("conversation-ledger");
  const { listConversations, targetFor } = await import("../dist/index.js");

  const repoDir = await realpath(await mkdtemp(join(tmpdir(), "turnbridge-fc-e2e-")));
  await git(["init", "-q", "-b", "main"], { cwd: repoDir });
  await git(["config", "user.email", "probe@turnbridge.test"], { cwd: repoDir });
  await git(["config", "user.name", "Turnbridge Probe"], { cwd: repoDir });
  await git(["config", "commit.gpgsign", "false"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "probe\n");
  await git(["add", "."], { cwd: repoDir });
  await git(["commit", "-q", "-m", "init"], { cwd: repoDir });
  const repo = await findRepo(repoDir);

  const cid = `claude-code:${crypto.randomUUID()}`;
  const draft = (seq, role, blocks) => ({
    kind: "conversation_turn",
    occurred_at: `2026-01-01T00:00:0${seq}.000Z`,
    actor: role === "user" ? { type: "human", id: "probe@turnbridge.test" } : { type: "agent", id: "claude-probe" },
    producer: { tool: "turnbridge-probe", source: "claude-code", session_id: cid.split(":")[1] },
    conversation: { id: cid, seq },
    content: { role, blocks },
  });
  await appendEvents(repo, [
    draft(0, "user", [{ type: "text", text: `The secret marker phrase is ${MARKER}. Remember it.` }]),
    draft(1, "assistant", [
      { type: "text", text: "Making that edit now." },
      { type: "tool_use", id: "toolu_e2e_probe", name: TOOL_NAME, input: { file_path: "/tmp/notes.txt" } },
    ]),
    draft(2, "user", [{ type: "tool_result", tool_use_id: "toolu_e2e_probe", content: "Applied 1 edit" }]),
  ]);

  const summary = (await listConversations(repo, { all: true })).find((c) => c.id === cid);
  const plan = await targetFor("codex").fabricate(summary, repoDir, { replayReasoning: true });
  const sid = plan.fabricatedConversationId.split(":")[1];
  const run = spawnSync("codex", ["exec", "--skip-git-repo-check", "resume", sid, PROMPT], {
    cwd: repoDir,
    encoding: "utf8",
    env,
    timeout: 180_000,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const ok = out.includes(MARKER) && out.includes(TOOL_NAME) && run.status === 0;
  console.log(
    `\ne2e (turnbridge fabricate -> codex resume): ${ok ? "USABLE" : "BROKEN"} ` +
      `exit=${run.status} marker=${out.includes(MARKER)} tool_named=${out.includes(TOOL_NAME)}`,
  );
  if (!ok) console.log(`  tail: ${out.trim().split("\n").slice(-6).join("\n        ")}`);

  const noted = plan.notes.map((n) => /^rollout file: (.+?) \(/.exec(n)).find(Boolean);
  if (noted) written.push(noted[1]);
  if (process.env.PROBE_KEEP !== "1") await rm(repoDir, { recursive: true, force: true });
}

if (process.env.PROBE_KEEP !== "1") {
  await Promise.all(written.map((f) => rm(f, { force: true })));
  await rm(cwd, { recursive: true, force: true });
  console.log("\ncleaned up fabricated rollouts and probe cwd");
} else {
  console.log(`\nPROBE_KEEP=1: left ${written.join(", ")}`);
}
