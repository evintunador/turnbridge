import assert from "node:assert/strict";
import test from "node:test";
import { appendEvents } from "conversation-ledger";
import { buildImportPayload } from "../targets/opencode.js";
import { listConversations } from "../conversations.js";
import { cleanupRepo, makeTempRepo, seedConversation } from "./helpers.js";

/**
 * Payload-shape tests for the opencode target. The import itself needs a real
 * opencode install (`npm run smoke:interactive opencode` covers that), but
 * every constraint docs/specs/opencode-session-format.md lists is a property
 * of the payload, and each one below was a real defect first.
 */

const SID = "66666666-6666-4666-8666-666666666666";
const NEW_ID = "ses_tb_77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-08-02T12:00:00.000Z");

const OPTS = {
  sessionId: NEW_ID,
  cwd: "/work/dir",
  version: "1.18.5",
  projectId: "abc123project",
  now: NOW,
  replayReasoning: true,
};

interface Part {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: Record<string, unknown>;
  messageID: string;
  sessionID: string;
  id: string;
}
interface Message {
  info: Record<string, unknown>;
  parts: Part[];
}
interface Payload {
  info: Record<string, unknown>;
  messages: Message[];
}

function blockDraft(conversationId: string, seq: number, role: string, blocks: unknown[]) {
  return {
    kind: "conversation_turn" as const,
    occurred_at: `2026-01-01T00:00:0${seq}.000Z`,
    actor:
      role === "user"
        ? { type: "human" as const, id: "me@x.com" }
        : { type: "agent" as const, id: "claude-test" },
    producer: { tool: "turnbridge-test", source: "claude-code", session_id: SID },
    conversation: { id: conversationId, seq },
    content: { role, blocks },
  };
}

async function payloadFor(
  blocks: Array<{ role: string; blocks: unknown[] }>,
  overrides: Partial<typeof OPTS> = {},
): Promise<{ payload: Payload; cleanup: () => Promise<void> }> {
  const repo = await makeTempRepo();
  const id = `claude-code:${SID}`;
  await appendEvents(
    repo,
    blocks.map((b, i) => blockDraft(id, i, b.role, b.blocks)),
  );
  const [summary] = await listConversations(repo, { all: true });
  const payload = buildImportPayload(summary!, { ...OPTS, ...overrides }) as unknown as Payload;
  return { payload, cleanup: () => cleanupRepo(repo) };
}

test("builds a session envelope opencode's importer accepts", async () => {
  const repo = await makeTempRepo();
  try {
    await seedConversation(repo, `claude-code:${SID}`, "claude-code", [
      { role: "user", text: "add a retry to the fetcher", seq: 0, email: "me@x.com" },
      { role: "assistant", text: "Done, retries three times.", seq: 1 },
    ]);
    const [summary] = await listConversations(repo, { all: true });
    const payload = buildImportPayload(summary!, OPTS) as unknown as Payload;

    assert.equal(payload.info["id"], NEW_ID);
    assert.equal(payload.info["directory"], "/work/dir");
    assert.equal(payload.info["projectID"], "abc123project");
    // opencode's own version, as a native session would carry
    assert.equal(payload.info["version"], "1.18.5");
    // titled by the conversation, not by turnbridge's import notice
    assert.equal(payload.info["title"], "add a retry to the fetcher (from Claude Code)");

    // notice + two turns, every part stamped with its own message and session
    assert.equal(payload.messages.length, 3);
    for (const message of payload.messages) {
      assert.equal(message.info["sessionID"], NEW_ID);
      for (const part of message.parts) {
        assert.equal(part.sessionID, NEW_ID);
        assert.equal(part.messageID, message.info["id"]);
      }
    }
    assert.match(payload.messages[0]!.parts[0]!.text!, /imported from Claude Code/);
    assert.equal(payload.messages[1]!.parts[0]!.text, "add a retry to the fetcher");
    assert.equal(payload.messages[2]!.parts[0]!.text, "Done, retries three times.");
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)));
  } finally {
    await cleanupRepo(repo);
  }
});

test("the import notice sorts ahead of history, not after it", async () => {
  // opencode orders messages by time.created, so a notice stamped at
  // fabrication time lands last, where a trailing user message renders as a
  // QUEUED prompt instead of a preamble.
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "hello" }] },
    { role: "assistant", blocks: [{ type: "text", text: "hi" }] },
  ]);
  try {
    const created = payload.messages.map((m) => (m.info["time"] as { created: number }).created);
    assert.ok(
      created[0]! < created[1]!,
      `notice must predate the first turn: ${created.join(", ")}`,
    );
    for (let i = 1; i < created.length; i++) {
      assert.ok(created[i - 1]! <= created[i]!, `history went backward at ${i}`);
    }
    // and it must not be the newest message in the session
    assert.equal(Math.max(...created), created[created.length - 1]);
  } finally {
    await cleanup();
  }
});

test("assistant messages parent to their prompting user message; user messages are unparented", async () => {
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "one" }] },
    { role: "assistant", blocks: [{ type: "text", text: "a" }] },
    { role: "assistant", blocks: [{ type: "text", text: "b" }] },
    { role: "user", blocks: [{ type: "text", text: "two" }] },
    { role: "assistant", blocks: [{ type: "text", text: "c" }] },
  ]);
  try {
    const ids = new Set(payload.messages.map((m) => m.info["id"] as string));
    const users = payload.messages.filter((m) => m.info["role"] === "user");
    for (const user of users) {
      assert.equal(user.info["parentID"], undefined, "user messages carry no parentID");
    }
    // the import notice is itself a user message, so it leads the list
    const [notice, firstUser, secondUser] = users;
    assert.ok(notice && firstUser && secondUser);

    const assistants = payload.messages.filter((m) => m.info["role"] === "assistant");
    assert.equal(assistants.length, 3);
    // the two consecutive replies share the user message that prompted them
    assert.equal(assistants[0]!.info["parentID"], firstUser.info["id"]);
    assert.equal(assistants[1]!.info["parentID"], firstUser.info["id"]);
    assert.equal(assistants[2]!.info["parentID"], secondUser.info["id"]);
    for (const a of assistants) {
      assert.ok(ids.has(a.info["parentID"] as string), "no dangling parentID");
    }
  } finally {
    await cleanup();
  }
});

test("tool parts carry every key the importer requires", async () => {
  // `Missing key at ["state"]["title"]` — import validation rejects a tool
  // part whose state is missing any of these six, and rejects it part-way.
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "fix the typo" }] },
    {
      role: "assistant",
      blocks: [
        { type: "text", text: "Editing now." },
        {
          type: "tool_use",
          id: "toolu_abc123",
          name: "Edit",
          input: { file_path: "/a.txt", old_string: "teh", new_string: "the" },
        },
      ],
    },
    {
      role: "user",
      blocks: [{ type: "tool_result", tool_use_id: "toolu_abc123", content: "Applied 1 edit" }],
    },
  ]);
  try {
    const tool = payload.messages.flatMap((m) => m.parts).find((p) => p.type === "tool");
    assert.ok(tool, "tool_use becomes a tool part");
    assert.equal(tool.tool, "Edit");
    assert.equal(tool.callID, "toolu_abc123");
    assert.deepEqual(Object.keys(tool.state!).sort(), [
      "input",
      "metadata",
      "output",
      "status",
      "time",
      "title",
    ]);
    assert.equal(tool.state!["status"], "completed");
    assert.deepEqual(tool.state!["input"], {
      file_path: "/a.txt",
      old_string: "teh",
      new_string: "the",
    });
    const time = tool.state!["time"] as { start: number; end: number };
    assert.equal(typeof time.start, "number");
    assert.equal(typeof time.end, "number");
  } finally {
    await cleanup();
  }
});

test("a paired tool result rides in its call's state.output, exactly once", async () => {
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "fix the typo" }] },
    {
      role: "assistant",
      blocks: [{ type: "tool_use", id: "toolu_abc123", name: "Edit", input: { a: 1 } }],
    },
    {
      role: "user",
      blocks: [{ type: "tool_result", tool_use_id: "toolu_abc123", content: "Applied 1 edit" }],
    },
  ]);
  try {
    const parts = payload.messages.flatMap((m) => m.parts);
    const tool = parts.find((p) => p.type === "tool")!;
    assert.equal(tool.state!["output"], "Applied 1 edit");
    // and not duplicated as loose text alongside it
    assert.equal(
      parts.filter((p) => p.type === "text" && p.text?.includes("Applied 1 edit")).length,
      0,
    );
  } finally {
    await cleanup();
  }
});

test("an unpaired tool result stays labeled text, keeping its content visible", async () => {
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "run it" }] },
    // no matching tool_use anywhere in this conversation
    {
      role: "user",
      blocks: [{ type: "tool_result", tool_use_id: "toolu_missing", content: "exit 0" }],
    },
  ]);
  try {
    const parts = payload.messages.flatMap((m) => m.parts);
    assert.equal(parts.filter((p) => p.type === "tool").length, 0);
    const folded = parts.find((p) => p.text?.includes("exit 0"));
    assert.ok(folded, "orphaned result content survives as text");
    assert.match(folded.text!, /^\[tool result\]/);
  } finally {
    await cleanup();
  }
});

test("a tool call whose output was never captured says so, rather than claiming one", async () => {
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "look" }] },
    {
      role: "assistant",
      blocks: [{ type: "tool_use", id: "toolu_noresult", name: "Read", input: {} }],
    },
  ]);
  try {
    const tool = payload.messages.flatMap((m) => m.parts).find((p) => p.type === "tool")!;
    assert.match(String(tool.state!["output"]), /not captured/);
  } finally {
    await cleanup();
  }
});

test("thinking replays as a reasoning part, and folds to labeled text when replay is off", async () => {
  const turns = [
    { role: "user", blocks: [{ type: "text", text: "think about it" }] },
    {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "weighing the options" },
        { type: "text", text: "Here is the answer." },
      ],
    },
  ];

  const on = await payloadFor(turns);
  try {
    const parts = on.payload.messages.flatMap((m) => m.parts);
    const reasoning = parts.find((p) => p.type === "reasoning");
    assert.ok(reasoning, "replay on: thinking becomes a native reasoning part");
    assert.equal(reasoning.text, "weighing the options");
    assert.match(on.payload.messages[0]!.parts[0]!.text!, /visible-thinking block\(s\) are replayed/);
  } finally {
    await on.cleanup();
  }

  const off = await payloadFor(turns, { replayReasoning: false });
  try {
    const parts = off.payload.messages.flatMap((m) => m.parts);
    assert.equal(parts.filter((p) => p.type === "reasoning").length, 0);
    const folded = parts.find((p) => p.text?.includes("weighing the options"));
    assert.ok(folded, "replay off: the thinking text is folded, never dropped");
    assert.match(folded.text!, /^\[visible thinking\]/);
    assert.doesNotMatch(off.payload.messages[0]!.parts[0]!.text!, /replayed as reasoning/);
  } finally {
    await off.cleanup();
  }
});

test("the source model id is propagated verbatim, never a recognized-but-false one", async () => {
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "hi" }] },
    { role: "assistant", blocks: [{ type: "text", text: "hello" }] },
  ]);
  try {
    const assistant = payload.messages.find((m) => m.info["role"] === "assistant")!;
    assert.equal(assistant.info["modelID"], "claude-test");
    // the provider is turnbridge's own, precisely because it is not a real
    // opencode provider: the composer falls back to the user's model
    assert.equal(assistant.info["providerID"], "turnbridge");
    assert.deepEqual(payload.info["model"], { id: "claude-test", providerID: "turnbridge" });
  } finally {
    await cleanup();
  }
});

test("every message timestamp is a finite epoch-millisecond number", async () => {
  const { payload, cleanup } = await payloadFor([
    { role: "user", blocks: [{ type: "text", text: "q" }] },
    { role: "assistant", blocks: [{ type: "text", text: "a" }] },
  ]);
  try {
    for (const message of payload.messages) {
      const time = message.info["time"] as { created: number; completed?: number };
      assert.equal(typeof time.created, "number");
      assert.ok(Number.isFinite(time.created), `non-finite created: ${time.created}`);
      if (message.info["role"] === "assistant") {
        assert.ok(Number.isFinite(time.completed!), "assistant messages carry a completed stamp");
      }
    }
  } finally {
    await cleanup();
  }
});

test("a conversation with no visible user text still gets a usable picker title", async () => {
  const { payload, cleanup } = await payloadFor([
    { role: "assistant", blocks: [{ type: "text", text: "thinking out loud" }] },
  ]);
  try {
    assert.equal(payload.info["title"], "Imported from Claude Code");
  } finally {
    await cleanup();
  }
});
