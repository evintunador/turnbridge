import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionLines, encodeProjectDir } from "../targets/claude-code.js";
import { listConversations } from "../conversations.js";
import { cleanupRepo, makeTempRepo, seedConversation } from "./helpers.js";

const SID = "55555555-5555-4555-8555-555555555555";
const NEW_ID = "88888888-8888-4888-8888-888888888888";

test("project dir encoding replaces every non-alphanumeric character", () => {
  assert.equal(encodeProjectDir("/Users/me/dev/ds4-gateway"), "-Users-me-dev-ds4-gateway");
  assert.equal(encodeProjectDir("/tmp/dot.test_dir"), "-tmp-dot-test-dir");
});

test("builds a parentUuid-chained session with timestamps and full envelopes", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `codex:${SID}`, "codex", [
      { role: "user", text: "profile the slow endpoint", seq: 0, email: "me@x.com" },
      { role: "assistant", text: "The N+1 query is the culprit.", seq: 1 },
    ]);
    const [summary] = await listConversations(repo, { all: true });
    const lines = buildSessionLines(summary!, NEW_ID, "/work/dir", "2.1.215", new Date());

    // import notice + two turns
    assert.equal(lines.length, 3);

    // load-bearing parentUuid chain: null first, then previous line's uuid
    assert.equal(lines[0]!.parentUuid, null);
    assert.equal(lines[1]!.parentUuid, lines[0]!.uuid);
    assert.equal(lines[2]!.parentUuid, lines[1]!.uuid);

    for (const line of lines) {
      assert.ok(line.timestamp, "timestamp is required on every line");
      assert.equal(line.sessionId, NEW_ID);
      assert.equal(line.cwd, "/work/dir");
      assert.equal(line.isSidechain, false);
    }

    assert.equal(lines[0]!.type, "user");
    assert.match(JSON.stringify(lines[0]!.message), /imported from Codex/);

    const assistant = lines[2]!;
    assert.equal(assistant.type, "assistant");
    assert.equal(assistant.message["role"], "assistant");
    assert.equal(assistant.message["stop_reason"], "end_turn");
    assert.equal(assistant.message["model"], "test-model");
  } finally {
    await cleanupRepo(repo);
  }
});
