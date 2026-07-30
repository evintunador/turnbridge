// Resolves the "large/long histories untested" gap in both spec docs
// (claude-session-format.md §7, codex-rollout-format.md §8.4). Every earlier
// verification used 2-3 line files.
//
// The question worth answering is NOT "where is the byte cliff". Both CLIs
// already own context management — Claude Code auto-compacts, Codex has a
// `compacted` rollout item — and turnbridge deliberately passes history
// through without truncating it. The question is whether that machinery
// engages gracefully on a history that arrives all at once at session start,
// rather than growing turn by turn the way it normally would.
//
// So this probe plants a marker in the FIRST turn and another in the LAST,
// then asks for both. The last marker proves the session loaded at all; the
// first proves the early history was not silently dropped on the way in.
//
// Deliberately capped rather than escalated to failure: the useful claim is
// "verified clean to N turns", not the exact cliff location.
//   PROBE_TURNS=300 node scripts/probe-large-history.mjs [claude-code|codex]
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvents, findRepo, git } from "conversation-ledger";
import { listConversations, targetFor } from "../dist/index.js";

const TURNS = Number(process.env.PROBE_TURNS ?? 300);
const RUN = Math.random().toString(36).slice(2, 8);
const FIRST_MARKER = `TB-FIRST-${RUN}`;
const LAST_MARKER = `TB-LAST-${RUN}`;
const PROMPT =
  "Two questions, one line each, from earlier in this conversation: " +
  "(1) what was the FIRST secret marker phrase I gave you? " +
  "(2) what was the LAST secret marker phrase I gave you?";

// Filler with enough substance that the history has realistic bulk rather
// than 300 copies of "hi" that any compactor would collapse for free.
const FILLER =
  "We reviewed the retry backoff in the fetch layer, walked through the timeout " +
  "handling, and confirmed the error path surfaces the original cause rather than " +
  "swallowing it. Nothing else changed in that pass.";

const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targetNames = names.length ? names : ["claude-code", "codex"];

const dir = await realpath(await mkdtemp(join(tmpdir(), "turnbridge-large-")));
await git(["init", "-q", "-b", "main"], { cwd: dir });
await git(["config", "user.email", "probe@turnbridge.test"], { cwd: dir });
await git(["config", "user.name", "Turnbridge Probe"], { cwd: dir });
await git(["config", "commit.gpgsign", "false"], { cwd: dir });
await writeFile(join(dir, "README.md"), "probe\n");
await git(["add", "."], { cwd: dir });
await git(["commit", "-q", "-m", "init"], { cwd: dir });
const repo = await findRepo(dir);

const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE|CODEX_[A-Z])/.test(k)),
);

const results = [];
for (const targetName of targetNames) {
  const target = targetFor(targetName);
  if (!(await target.isInstalled())) {
    console.log(`skip ${targetName}: not on PATH`);
    continue;
  }

  // A fresh conversation per target: fabricating for one target must not see
  // the other target's fabricated session as part of its own history.
  const cid = `${targetName === "codex" ? "claude-code" : "codex"}:${crypto.randomUUID()}`;
  const sessionId = cid.split(":").slice(1).join(":");
  const source = cid.split(":")[0];
  const stamp = (seq) => {
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000);
    return t.toISOString();
  };
  const drafts = [];
  for (let seq = 0; seq < TURNS; seq++) {
    const isUser = seq % 2 === 0;
    let text;
    if (seq === 0) text = `The first secret marker phrase is ${FIRST_MARKER}. Remember it.`;
    else if (seq === TURNS - 1) text = `The last secret marker phrase is ${LAST_MARKER}. Remember it.`;
    else text = `Turn ${seq}. ${FILLER}`;
    drafts.push({
      kind: "conversation_turn",
      occurred_at: stamp(seq),
      actor: isUser
        ? { type: "human", id: "probe@turnbridge.test" }
        : { type: "agent", id: "probe-model" },
      producer: { tool: "turnbridge-probe", source, session_id: sessionId },
      conversation: { id: cid, seq },
      content: { role: isUser ? "user" : "assistant", blocks: [{ type: "text", text }] },
    });
  }
  // The last turn must be a user turn so the marker is something "I gave you".
  if (drafts[TURNS - 1].actor.type !== "human") {
    drafts[TURNS - 1].actor = { type: "human", id: "probe@turnbridge.test" };
    drafts[TURNS - 1].content.role = "user";
  }
  await appendEvents(repo, drafts);

  const summary = (await listConversations(repo, { all: true })).find((c) => c.id === cid);
  if (!summary) throw new Error(`seeded conversation ${cid} not visible`);
  const plan = await target.fabricate(summary, dir, { replayReasoning: true });
  const fileNote = plan.notes.map((n) => /(?:session|rollout) file: (.+?) \(/.exec(n)).find(Boolean);
  const path = fileNote?.[1];
  const bytes = path ? (await stat(path)).size : 0;
  console.log(
    `${targetName}: fabricated ${TURNS} turns, ${(bytes / 1024).toFixed(0)} KB -> resuming...`,
  );

  const args =
    targetName === "codex"
      ? ["exec", "--skip-git-repo-check", "resume", plan.fabricatedConversationId.split(":")[1], PROMPT]
      : ["--resume", plan.fabricatedConversationId.split(":")[1], "-p", PROMPT, "--max-turns", "1"];
  const started = process.hrtime.bigint();
  const run = spawnSync(target.binary, args, { cwd: dir, encoding: "utf8", env, timeout: 600_000 });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;

  results.push({
    target: targetName,
    turns: TURNS,
    kb: Math.round(bytes / 1024),
    exit: run.status,
    first: out.includes(FIRST_MARKER),
    last: out.includes(LAST_MARKER),
    seconds: seconds.toFixed(1),
    tail: out.trim().split("\n").slice(-5).join("\n        "),
  });
  if (path && process.env.PROBE_KEEP !== "1") await rm(path, { force: true });
}

console.log("\n--- results ---");
for (const r of results) {
  const verdict = r.exit === 0 && r.first && r.last ? "CLEAN" : r.exit === 0 ? "LOADED-BUT-LOSSY" : "FAILED";
  console.log(
    `${r.target.padEnd(12)} ${verdict.padEnd(17)} turns=${r.turns} size=${r.kb}KB exit=${r.exit} ` +
      `earliest_turn_recalled=${r.first} latest_turn_recalled=${r.last} ${r.seconds}s`,
  );
  if (verdict !== "CLEAN") console.log(`  tail: ${r.tail}`);
}

if (process.env.PROBE_KEEP !== "1") {
  await rm(dir, { recursive: true, force: true });
  console.log("\ncleaned up");
}
process.exit(results.every((r) => r.exit === 0 && r.first && r.last) ? 0 : 1);
