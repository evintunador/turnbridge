import assert from "node:assert/strict";
import test from "node:test";
import { listConversations } from "../conversations.js";
import { cleanupRepo, makeTempRepo, seedConversation } from "./helpers.js";

const SID_A = "11111111-1111-4111-8111-111111111111";
const SID_B = "22222222-2222-4222-8222-222222222222";

test("groups events into conversations with titles, owners, ordering", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `claude-code:${SID_A}`, "claude-code", [
      { role: "user", text: "<command-name>/clear</command-name>", seq: 0, email: "me@x.com" },
      { role: "user", text: "fix the login bug", seq: 1, email: "me@x.com", display: "Me" },
      { role: "assistant", text: "On it", seq: 2 },
    ]);
    await seedConversation(repo, `codex:${SID_B}`, "codex", [
      {
        role: "user",
        text: "refactor the parser",
        seq: 0,
        email: "them@x.com",
        occurredAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    const all = await listConversations(repo, { all: true });
    assert.equal(all.length, 2);
    // newest last-activity first
    assert.equal(all[0]!.source, "codex");
    assert.equal(all[0]!.sessionId, SID_B);

    const claude = all[1]!;
    assert.equal(claude.title, "fix the login bug"); // CLI-injected <command-name> line skipped
    assert.equal(claude.turnCount, 3);
    assert.deepEqual(claude.owners, ["me@x.com"]);
    assert.deepEqual(claude.ownerDisplays, ["Me"]);
    assert.equal(claude.events[0]!.conversation!.seq, 0);
  } finally {
    await cleanupRepo(repo);
  }
});

test("ownership filter: default hides others, keeps own and unattributed", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `claude-code:${SID_A}`, "claude-code", [
      { role: "user", text: "mine", seq: 0, email: "me@x.com" },
    ]);
    await seedConversation(repo, `codex:${SID_B}`, "codex", [
      { role: "user", text: "theirs", seq: 0, email: "them@x.com" },
    ]);
    await seedConversation(repo, "claude-code:legacy", "claude-code", [
      { role: "user", text: "pre-identity capture", seq: 0 },
    ]);

    const mine = await listConversations(repo, { user: "me@x.com" });
    assert.deepEqual(mine.map((c) => c.title).sort(), ["mine", "pre-identity capture"]);

    const everyone = await listConversations(repo, { user: "me@x.com", all: true });
    assert.equal(everyone.length, 3);
  } finally {
    await cleanupRepo(repo);
  }
});
