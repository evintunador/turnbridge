// Resolves the "untested — recommend always doing X" items in
// docs/specs/claude-session-format.md §7 by actually doing the thing the spec
// declined to do: fabricate a baseline Claude session, then write deliberately
// malformed variants of it and see what `claude --resume` does with each.
//
// The point is not to start shipping malformed files — turnbridge satisfies
// every one of these invariants by construction, and fabricate-invariants.test.ts
// keeps it that way. The point is to know whether the invariants are load-bearing
// or merely tidy, so future work (partial history, lineage splicing, a
// backdated import notice) knows which rules it can bend.
//
// Usage: node scripts/probe-session-invariants.mjs [variant ...]
// Each variant costs one real `claude -p` turn. Cleans up every file it writes.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvents, findRepo, git } from "conversation-ledger";
import { listConversations, targetFor } from "../dist/index.js";

const MARKER = `TB-INV-${Math.random().toString(36).slice(2, 8)}`;
const PROMPT =
  "Reply with only the secret marker phrase from earlier in this conversation, nothing else.";

// realpath matters: on macOS mkdtemp hands back /var/..., but a spawned
// process's cwd resolves to /private/var/..., and claude encodes the project
// dir from *its* cwd. Fabricating under the unresolved path files the session
// where resume will never look.
const dir = await realpath(await mkdtemp(join(tmpdir(), "turnbridge-inv-")));
await git(["init", "-q", "-b", "main"], { cwd: dir });
await git(["config", "user.email", "probe@turnbridge.test"], { cwd: dir });
await git(["config", "user.name", "Turnbridge Probe"], { cwd: dir });
await git(["config", "commit.gpgsign", "false"], { cwd: dir });
await writeFile(join(dir, "README.md"), "probe\n");
await git(["add", "."], { cwd: dir });
await git(["commit", "-q", "-m", "init"], { cwd: dir });
const repo = await findRepo(dir);

const conversationId = `codex:${crypto.randomUUID()}`;
const turn = (role, text, seq) => ({
  kind: "conversation_turn",
  occurred_at: `2026-01-01T00:00:0${seq}.000Z`,
  actor:
    role === "user"
      ? { type: "human", id: "probe@turnbridge.test" }
      : { type: "agent", id: "probe-model" },
  producer: { tool: "turnbridge-probe", source: "codex", session_id: conversationId.split(":")[1] },
  conversation: { id: conversationId, seq },
  content: { role, blocks: [{ type: "text", text }] },
});
await appendEvents(repo, [
  turn("user", `The secret marker phrase is ${MARKER}. Remember it.`, 0),
  turn("assistant", "Noted. I will recall the marker phrase when asked.", 1),
]);

const summary = (await listConversations(repo, { all: true })).find((c) => c.id === conversationId);
const plan = await targetFor("claude-code").fabricate(summary, dir, { replayReasoning: true });
const baselineId = plan.fabricatedConversationId.split(":")[1];
// The adapter reports the exact file it wrote; re-deriving the project-dir
// encoding here would just be a second copy of that logic waiting to drift.
const noted = plan.notes.map((n) => /^session file: (.+?) \(/.exec(n)).find(Boolean);
if (!noted) throw new Error(`could not find session file path in plan notes:\n${plan.notes.join("\n")}`);
const baselinePath = noted[1];
const sessionDir = dirname(baselinePath);
const baseline = (await readFile(baselinePath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
console.log(`baseline session ${baselineId} (${baseline.length} lines) in ${sessionDir}`);

/**
 * Each variant returns mutated lines. `sessionId` is rewritten to the new
 * filename id first, so only the mutation under test differs from baseline.
 */
const VARIANTS = {
  baseline: (lines) => lines,

  // What turnbridge ships today, stated explicitly: line 1 (our synthetic
  // import notice) is stamped at fabrication time and is therefore NEWER than
  // every history line beneath it. Confirms the current file is loadable.
  "notice-newest": (lines) => lines,

  // The candidate fix: backdate the notice to just before the first real
  // event so the file never steps backward. If this resumes AND still sorts
  // sensibly in the picker, the ordering fix is safe to ship.
  monotonic: (lines) => {
    if (lines.length < 2) return lines;
    const first = Date.parse(lines[1].timestamp);
    return lines.map((l, i) =>
      i === 0 ? { ...l, timestamp: new Date(first - 1).toISOString() } : l,
    );
  },

  // spec §7: "behavior on mismatch is unknown; recommend always keeping them identical"
  "sessionid-mismatch": (lines) =>
    lines.map((l) => ({ ...l, sessionId: "00000000-0000-4000-8000-000000000000" })),

  // spec §7: parentUuid pointing at a uuid that appears nowhere in the file
  "dangling-parent": (lines) =>
    lines.map((l, i) =>
      i === 0 ? { ...l, parentUuid: "deadbeef-0000-4000-8000-000000000000" } : l,
    ),

  // spec §7: duplicate/collided uuid values. Claude reconstructs history by
  // walking parentUuid backward from the last line, so a collision is the
  // case most likely to silently truncate or loop.
  "duplicate-uuid": (lines) => {
    if (lines.length < 3) return lines;
    const dup = lines[1].uuid;
    return lines.map((l, i) => (i === 2 ? { ...l, uuid: dup } : l));
  },
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(VARIANTS);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE|CODEX_[A-Z])/.test(k)),
);

const written = [baselinePath];
const results = [];
for (const name of names) {
  const mutate = VARIANTS[name];
  if (!mutate) {
    console.error(`unknown variant: ${name}`);
    continue;
  }
  const id = crypto.randomUUID();
  const path = join(sessionDir, `${id}.jsonl`);
  const lines = mutate(baseline.map((l) => ({ ...l, sessionId: id })));
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  written.push(path);

  const run = spawnSync("claude", ["--resume", id, "-p", PROMPT, "--max-turns", "1"], {
    cwd: dir,
    encoding: "utf8",
    env,
    timeout: 180_000,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const recalled = out.includes(MARKER);
  results.push({ variant: name, exit: run.status, recalled, detail: out.trim().split("\n").pop() ?? "" });
  console.log(`${recalled ? "PASS" : "FAIL"} ${name} (exit ${run.status})`);
}

console.log("\n--- results ---");
for (const r of results) {
  console.log(
    `${r.variant.padEnd(20)} exit=${String(r.exit).padEnd(5)} marker_recalled=${r.recalled}  ${r.recalled ? "" : r.detail.slice(0, 140)}`,
  );
}

if (process.env.PROBE_KEEP !== "1") {
  await Promise.all(written.map((p) => rm(p, { force: true })));
  await rm(sessionDir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  console.log("\ncleaned up fabricated sessions and probe repo");
} else {
  console.log(`\nPROBE_KEEP=1: left ${sessionDir} and ${dir} in place`);
}
