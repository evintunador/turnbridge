import xterm from "@xterm/headless";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

/** Reconstruct screen state, rather than treating stripped ANSI bytes as a screenshot. */
export async function terminalScreen(output: string, markers: readonly string[] = []) {
  const terminal = new xterm.Terminal({ cols: 160, rows: 40, scrollback: 5000, allowProposedApi: true });
  let best = { score: -1, text: "", viewport: [] as string[] };
  const observed = new Map<string, string>();
  try {
    // Sample rendered lines and before destructive terminal operations. A PTY
    // read may contain both an answer and the app's alternate-screen exit;
    // sampling only arbitrary byte chunks loses genuinely displayed content.
    const frames = output.split(/(?<=\n)|(?=\x1b\[(?:[\d;?]*[JKPXLMST]|\?104[79][hl]))/);
    for (const frame of frames) for (let start = 0; start < frame.length; start += 2048) {
      await new Promise<void>(done => terminal.write(frame.slice(start, start + 2048), done));
      const buffer = terminal.buffer.active;
      const all = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "");
      const text = all.join("\n");
      for (const marker of markers) if (text.includes(marker) && !observed.has(marker)) observed.set(marker, text);
      const score = markers.filter(marker => text.includes(marker)).length;
      if (score >= best.score) best = { score, text, viewport: all.slice(buffer.viewportY, buffer.viewportY + terminal.rows) };
    }
    const lines = best.viewport.map((line, index) => `<text x="12" y="${24 + index * 18}">${escape(line)}</text>`).join("\n");
    return { text: best.text, matched: best.score, observedMarkers: [...observed.keys()], markerFrames: [...observed].map(([marker, text]) => ({ marker, text })),
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1640" height="740"><rect width="100%" height="100%" fill="#15171b"/><g fill="#e8e8e8" font-family="Menlo, monospace" font-size="16" xml:space="preserve">${lines}</g></svg>` };
  } finally { terminal.dispose(); }
}
