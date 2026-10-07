import assert from "node:assert/strict";
import test from "node:test";
import { terminalScreen } from "../verification/screen.js";

test("render evidence retains markers viewed on separate native screens", async () => {
  const first = "A_HISTORY" + " ".repeat(2200);
  const second = "\x1b[2J\x1b[HB_ASSISTANT" + " ".repeat(2200);
  const screen = await terminalScreen(first + second, ["A_HISTORY", "B_ASSISTANT"]);
  assert.deepEqual(screen.observedMarkers.sort(), ["A_HISTORY", "B_ASSISTANT"]);
  assert.equal(screen.markerFrames.length, 2);
  assert(screen.markerFrames.every(frame => frame.text.includes(frame.marker)));
});

test("screen artifacts resolve cursor movement and overwrite rather than concatenating bytes", async () => {
  const screen = await terminalScreen("OLD\r\x1b[2KNEW\n\x1b[31m<script>\x1b[0m", ["NEW"]);
  assert.match(screen.text, /NEW/);
  assert.doesNotMatch(screen.text, /OLD/);
  assert.match(screen.svg, /&lt;script>/);
  assert.doesNotMatch(screen.svg, /<script>/);
});
