// Probe: does codex resume accept a REAL encrypted reasoning item replayed
// inside a fabricated rollout (same account, different session)? This is the
// load-bearing unknown for recording encrypted_content in cledger: if the
// API rejects cross-session replay, the capture-policy debate is moot.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { appendEvents, findRepo, git } from "conversation-ledger";
import { listConversations, targetFor } from "../dist/index.js";

// Donor: any real rollout containing a `reasoning` response_item with
// encrypted_content (find one: grep -rl encrypted_content ~/.codex/sessions).
// Verified 2026-07-21: same-account replay accepted across sessions and
// across CLI versions (0.144-created blob, resumed under 0.145). Still
// unverified: cross-account replay (needs a second OpenAI account).
const DONOR = process.argv[2];
if (!DONOR) throw new Error("usage: probe-encrypted-reasoning.mjs <donor-rollout.jsonl>");

// 1. Extract a real reasoning line (envelope + payload verbatim) from the donor.
const donorLines = (await readFile(DONOR, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
const reasoningLine = donorLines.find(
  (l) => l.type === "response_item" && l.payload?.type === "reasoning" && l.payload?.encrypted_content,
);
if (!reasoningLine) throw new Error("donor has no encrypted reasoning response_item");
console.log(
  `donor reasoning item: id=${reasoningLine.payload.id ?? "(none)"} blob=${reasoningLine.payload.encrypted_content.length} chars`,
);

// 2. Seed a marker conversation and fabricate a codex session from it.
const MARKER = `TB-ENCPROBE-${Math.random().toString(36).slice(2, 8)}`;
const dir = await mkdtemp(join(tmpdir(), "turnbridge-encprobe-"));
await git(["init", "-q", "-b", "main"], { cwd: dir });
await git(["config", "user.email", "smoke@turnbridge.test"], { cwd: dir });
await git(["config", "user.name", "Turnbridge Smoke"], { cwd: dir });
await git(["config", "commit.gpgsign", "false"], { cwd: dir });
await writeFile(join(dir, "README.md"), "probe\n");
await git(["add", "."], { cwd: dir });
await git(["commit", "-q", "-m", "init"], { cwd: dir });
const repo = await findRepo(dir);

const conversationId = `claude-code:${crypto.randomUUID()}`;
const turn = (role, text, seq) => ({
  kind: "conversation_turn",
  occurred_at: `2026-01-01T00:00:0${seq}.000Z`,
  actor: role === "user" ? { type: "human", id: "smoke@turnbridge.test" } : { type: "agent", id: "probe-model" },
  producer: { tool: "turnbridge-smoke", source: "claude-code", session_id: conversationId.split(":")[1] },
  conversation: { id: conversationId, seq },
  content: { role, blocks: [{ type: "text", text }] },
});
await appendEvents(repo, [
  turn("user", `The secret marker phrase is ${MARKER}. Remember it.`, 0),
  turn("assistant", `Noted. I will recall the marker phrase when asked.`, 1),
]);
const summary = (await listConversations(repo, { all: true })).find((c) => c.id === conversationId);
const plan = await targetFor("codex").fabricate(summary, dir);
const sessionId = plan.fabricatedConversationId.split(":")[1];
const rolloutPath = plan.notes.find((n) => n.includes("rollout file:")).split("rollout file: ")[1];
console.log(`fabricated session ${sessionId}`);

// 3. Inject the donor reasoning item immediately before the final assistant
//    message response_item (where a real turn's reasoning would sit).
const lines = (await readFile(rolloutPath, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
let insertAt = -1;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].type === "response_item" && lines[i].payload?.type === "message" && lines[i].payload?.role === "assistant") {
    insertAt = i;
    break;
  }
}
if (insertAt < 0) throw new Error("no assistant response_item in fabricated rollout");
const injected = { ...reasoningLine, timestamp: lines[insertAt].timestamp };
lines.splice(insertAt, 0, injected);
await writeFile(rolloutPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.log(`injected reasoning item before line ${insertAt}`);

// 4. Resume headless and ask for the marker.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE|CODEX_[A-Z])/.test(k)),
);
const result = spawnSync(
  "codex",
  ["exec", "--skip-git-repo-check", "resume", sessionId,
   "Reply with only the secret marker phrase from earlier in this conversation, nothing else."],
  { cwd: dir, encoding: "utf8", env, timeout: 180_000 },
);
const out = (result.stdout ?? "") + (result.stderr ?? "");
console.log("--- codex exec output (tail) ---");
console.log(out.split("\n").slice(-15).join("\n"));
const errors = out.match(/\b(400|invalid|rejected|unauthorized|decrypt\w*)\b/gi);
console.log(`error-indicator scan: ${errors ? JSON.stringify([...new Set(errors)]) : "none"}`);
console.log(
  out.includes(MARKER)
    ? `PROBE PASS: resume accepted the replayed encrypted reasoning and recalled ${MARKER}`
    : "PROBE FAIL: marker not recalled (see output above for whether the API rejected the reasoning item)",
);
process.exit(out.includes(MARKER) ? 0 : 1);
