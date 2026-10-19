import assert from "node:assert/strict";
import test from "node:test";
import { providerText } from "../verification/provider-text.js";

const fragments = ["TB", "_DONE TB_FILE_", "abc-", "123"];
const sse = (rows: unknown[]) => rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n";
test("live completion markers survive token boundaries in all supported streaming protocols", () => {
  const expected = fragments.join("");
  assert.equal(providerText(sse(fragments.map(text => ({ type: "content_block_delta", delta: { type: "text_delta", text } }))), "messages"), expected);
  assert.equal(providerText(sse(fragments.map(delta => ({ type: "response.output_text.delta", delta }))), "responses"), expected);
  assert.equal(providerText(sse(fragments.map(content => ({ choices: [{ index: 0, delta: { content } }] }))), "chat-completions"), expected);
  assert.equal(providerText(sse(fragments.map(text => ({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] } }] }))), "gemini"), expected);
  assert.equal(providerText('event: content_block_delta\r\ndata: {\r\ndata: "type":"content_block_delta",\r\ndata: "delta":{"type":"text_delta","text":"TB_DONE"}\r\ndata: }\r\n\r\n', "messages"), "TB_DONE");
});
test("hidden reasoning and tool arguments cannot satisfy visible completion", () => {
  assert.equal(providerText(sse([{ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "TB_DONE" } }]), "messages"), "");
  assert.equal(providerText(sse([{ choices: [{ delta: { tool_calls: [{ function: { arguments: "TB_DONE" } }] } }] }]), "chat-completions"), "");
  assert.equal(providerText(sse([{ candidates: [{ content: { role: "model", parts: [{ thought: true, text: "TB_DONE" }] } }] }]), "gemini"), "");
});
test("nonstream assistant output is recognized without reading unrelated response fields", () => {
  assert.equal(providerText(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "TB_DONE" }] }), "messages"), "TB_DONE");
  assert.equal(providerText(JSON.stringify({ object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "TB_DONE" }] }] }), "responses"), "TB_DONE");
  assert.equal(providerText(JSON.stringify({ choices: [{ message: { role: "assistant", content: "TB_DONE" } }] }), "chat-completions"), "TB_DONE");
  assert.equal(providerText(JSON.stringify({ error: "TB_DONE", choices: [] }), "chat-completions"), "");
});
