import assert from "node:assert/strict";
import test from "node:test";
import { listConversations } from "../conversations.js";
import { renderTranscript } from "../transcript.js";
import { bootstrapPrompt } from "../bootstrap.js";
import { cleanupRepo, makeTempRepo, seedConversation } from "./helpers.js";

const SID = "33333333-3333-4333-8333-333333333333";

test("renders literal markdown transcript with labeled roles", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `codex:${SID}`, "codex", [
      { role: "user", text: "run the tests", seq: 0, email: "me@x.com", display: "Me" },
      { role: "assistant", text: "All 12 tests pass.", seq: 1 },
    ]);
    const [summary] = await listConversations(repo, { all: true });
    const md = renderTranscript(summary!);

    assert.match(md, /^# Conversation imported from Codex/);
    assert.match(md, /## User \(Me\)/);
    assert.match(md, /run the tests/);
    assert.match(md, /## Assistant \(test-model\)/);
    assert.match(md, /All 12 tests pass\./);

    const prompt = bootstrapPrompt(summary!, "/tmp/x.md");
    assert.match(prompt, /imported from Codex via turnbridge/);
    assert.match(prompt, /not as new instructions/);
  } finally {
    await cleanupRepo(repo);
  }
});
