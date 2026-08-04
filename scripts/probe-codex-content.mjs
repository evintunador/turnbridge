// Content-level revalidation probe, run against whatever codex is installed
// (0.145.0 originally; last run 0.146.0, 2026-08-02): fabricate a session
// from a planted-marker conversation, then `codex exec resume <id>` asking
// the model to recall the marker — proves the model actually sees the
// fabricated history, not just that the TUI renders it.
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvents, findRepo, git } from "conversation-ledger";
import { listConversations, targetFor } from "../dist/index.js";

const MARKER = `TB-PROBE-${Math.random().toString(36).slice(2, 8)}`;

const dir = await mkdtemp(join(tmpdir(), "turnbridge-probe-"));
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
const plan = await targetFor("codex").fabricate(summary, dir, { replayReasoning: true });
const sessionId = plan.fabricatedConversationId.split(":")[1];
console.log(`fabricated codex session ${sessionId}`);

const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE|CODEX_[A-Z])/.test(k)),
);
const result = spawnSync(
  "codex",
  ["exec", "--skip-git-repo-check", "resume", sessionId,
   "Reply with only the secret marker phrase from earlier in this conversation, nothing else."],
  { cwd: dir, encoding: "utf8", env, timeout: 120_000 },
);
const out = (result.stdout ?? "") + (result.stderr ?? "");
console.log("--- codex exec output (tail) ---");
console.log(out.split("\n").slice(-15).join("\n"));
console.log(out.includes(MARKER) ? `PROBE PASS: model recalled ${MARKER}` : "PROBE FAIL: marker not recalled");
process.exit(out.includes(MARKER) ? 0 : 1);
