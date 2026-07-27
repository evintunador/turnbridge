import assert from "node:assert/strict";
import test from "node:test";
import { appendEvents } from "conversation-ledger";
import { buildRolloutLines } from "../targets/codex.js";
import { listConversations } from "../conversations.js";
import { cleanupRepo, makeTempRepo, reasoningEventDraft, seedConversation } from "./helpers.js";

const SID = "44444444-4444-4444-8444-444444444444";
const NEW_ID = "99999999-9999-4999-8999-999999999999";

test("builds a minimal valid rollout: session_meta + message response_items", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `claude-code:${SID}`, "claude-code", [
      { role: "user", text: "add a retry to the fetcher", seq: 0, email: "me@x.com" },
      { role: "assistant", text: "Done, retries three times.", seq: 1 },
    ]);
    const [summary] = await listConversations(repo, { all: true });
    const lines = buildRolloutLines(summary!, NEW_ID, "/work/dir", "0.144.6", new Date());

    const meta = lines[0]!;
    assert.equal(meta.type, "session_meta");
    assert.equal(meta.payload["id"], NEW_ID);
    assert.equal(meta.payload["session_id"], NEW_ID);
    assert.equal(meta.payload["cwd"], "/work/dir");
    assert.equal(meta.payload["cli_version"], "0.144.6");

    // import notice first, then the two turns — as model-context response_items
    const messages = lines
      .filter((l) => l.type === "response_item")
      .map((l) => l.payload as Record<string, unknown>);
    assert.equal(messages.length, 3);
    assert.match(
      (messages[0]!["content"] as { text: string }[])[0]!.text,
      /imported from Claude Code/,
    );
    assert.equal(messages[1]!["role"], "user");
    assert.deepEqual(messages[1]!["content"], [
      { type: "input_text", text: "add a retry to the fetcher" },
    ]);
    assert.equal(messages[2]!["role"], "assistant");
    assert.deepEqual(messages[2]!["content"], [
      { type: "output_text", text: "Done, retries three times." },
    ]);

    // each turn also carries an event_msg twin so the TUI scrollback renders it
    const displays = lines
      .filter((l) => l.type === "event_msg")
      .map((l) => l.payload as Record<string, unknown>);
    assert.equal(displays.length, 3);
    assert.equal(displays[1]!["type"], "user_message");
    assert.equal(displays[1]!["message"], "add a retry to the fetcher");
    assert.equal(displays[2]!["type"], "agent_message");
    assert.equal(displays[2]!["message"], "Done, retries three times.");
    // user display precedes its response_item; assistant display follows it
    const kinds = lines.map((l) => `${l.type}:${(l.payload as { type?: string; role?: string }).type ?? ""}${(l.payload as { role?: string }).role ?? ""}`);
    assert.deepEqual(kinds.slice(3), [
      "event_msg:user_message",
      "response_item:messageuser",
      "response_item:messageassistant",
      "event_msg:agent_message",
    ]);

    // every line JSON-serializable and carrying a UTC timestamp
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(line)));
      assert.match(line.timestamp, /Z$/);
    }
  } finally {
    await cleanupRepo(repo);
  }
});

test("replays a Codex-origin reasoning blob verbatim, in seq order, and updates the notice", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `codex:${SID}`, "codex", [
      { role: "user", text: "why does the retry loop back off?", seq: 0, email: "me@x.com" },
      { role: "assistant", text: "To avoid hammering a failing endpoint.", seq: 2 },
    ]);
    await appendEvents(repo, [
      reasoningEventDraft(`codex:${SID}`, "codex", { seq: 1, encryptedContent: "REAL-BLOB-XYZ" }),
    ]);
    const [summary] = await listConversations(repo, { all: true });

    const lines = buildRolloutLines(summary!, NEW_ID, "/work/dir", "0.144.6", new Date(), true);
    const responseItems = lines.filter((l) => l.type === "response_item");
    const reasoningLine = responseItems.find(
      (l) => (l.payload as Record<string, unknown>)["type"] === "reasoning",
    )!;
    assert.equal(
      (reasoningLine.payload as { encrypted_content: string }).encrypted_content,
      "REAL-BLOB-XYZ",
    );

    // sits between its neighboring turns, matching original seq order
    const orderedTypes = responseItems.map((l) => {
      const payload = l.payload as { type?: string; role?: string };
      return payload.type === "reasoning" ? "reasoning" : payload.role;
    });
    assert.deepEqual(orderedTypes.slice(1), ["user", "reasoning", "assistant"]);

    // the import notice now discloses the replay instead of claiming nothing was transferred
    const notice = (
      (responseItems[0]!.payload as { content: { text: string }[] }).content[0]!.text
    );
    assert.match(notice, /1 encrypted reasoning block\(s\)/);
    // still honest that the replay is partial: everything else stays folded text
    assert.match(notice, /all other hidden reasoning.*were not transferred/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("does not replay reasoning when replayReasoning is false", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `codex:${SID}`, "codex", [
      { role: "user", text: "hi", seq: 0, email: "me@x.com" },
    ]);
    await appendEvents(repo, [reasoningEventDraft(`codex:${SID}`, "codex", { seq: 1 })]);
    const [summary] = await listConversations(repo, { all: true });

    const lines = buildRolloutLines(summary!, NEW_ID, "/work/dir", "0.144.6", new Date(), false);
    assert.equal(
      lines.filter((l) => (l.payload as Record<string, unknown>)["type"] === "reasoning").length,
      0,
    );
    const notice = (
      (lines.find((l) => l.type === "response_item")!.payload as { content: { text: string }[] })
        .content[0]!.text
    );
    assert.match(notice, /hidden reasoning and provider-private state were not transferred/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("never replays a reasoning event whose own producer.source isn't codex", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `codex:${SID}`, "codex", [
      { role: "user", text: "hi", seq: 0, email: "me@x.com" },
    ]);
    // Can't arise from real capture today (a conversation groups by one
    // native session id, so it's single-source) — this exercises the
    // per-event gate defensively rather than trusting that invariant.
    await appendEvents(repo, [
      reasoningEventDraft(`codex:${SID}`, "codex", { seq: 1, source: "claude-code" }),
    ]);
    const [summary] = await listConversations(repo, { all: true });

    const lines = buildRolloutLines(summary!, NEW_ID, "/work/dir", "0.144.6", new Date(), true);
    assert.equal(
      lines.filter((l) => (l.payload as Record<string, unknown>)["type"] === "reasoning").length,
      0,
    );
  } finally {
    await cleanupRepo(repo);
  }
});
