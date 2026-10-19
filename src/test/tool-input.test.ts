import assert from "node:assert/strict";
import test from "node:test";
import { toolInput } from "../tool-input.js";

test("native tool inputs decode Codex JSON arguments without double encoding", () => {
  assert.deepEqual(toolInput('{"cmd":"cat café.txt","login":false}'), { cmd: "cat café.txt", login: false });
  assert.deepEqual(toolInput({ path: "/tmp/a" }), { path: "/tmp/a" });
  assert.deepEqual(toolInput("not json"), { value: "not json" });
  assert.deepEqual(toolInput(null), {});
  assert.deepEqual(toolInput('["a"]'), { value: '["a"]' });
});
