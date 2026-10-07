import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceEvent } from "conversation-ledger";
import { capturedCompletion } from "../verification/worker.js";

test("automatic capture requires a visible final assistant reply, not an agent tool result or metadata", () => {
  const event = { kind: "conversation_turn", actor: { type: "agent" }, content: { role: "assistant", blocks: [{ type: "text", text: "TB_DONE TB_FILE_fresh" }] } } as unknown as EvidenceEvent;
  assert(capturedCompletion([event], "TB_FILE_fresh"));
  assert(capturedCompletion([{ ...event, content: { ...event.content as object, role: "model" } }], "TB_FILE_fresh"));
  assert(!capturedCompletion([event], "TB_FILE_other"));
  assert(!capturedCompletion([{ ...event, kind: "metadata" }], "TB_FILE_fresh"));
  assert(!capturedCompletion([{ ...event, content: { role: "tool", blocks: [{ type: "text", text: "TB_DONE TB_FILE_fresh" }] } }], "TB_FILE_fresh"));
  assert(!capturedCompletion([{ ...event, content: { role: "assistant", blocks: [{ type: "thinking", text: "TB_DONE TB_FILE_fresh" }] } }], "TB_FILE_fresh"));
});
