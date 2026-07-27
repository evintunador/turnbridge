// Resolves the two picker unknowns the specs left inferred rather than tested:
//   claude-session-format.md §7 — where does the resume picker get its title?
//     ("most likely the ai-title line, fallback to first user message ... an
//      inference from file structure, NOT independently confirmed")
//   codex-rollout-format.md §8.3 — how does the picker match cwd, and what does
//     `--all` change? (only direct `resume <id>` was ever verified)
//
// Both need a real TUI, so this drives each picker through a pty and reads the
// rendered list. Purely cosmetic questions — neither affects whether a bridged
// session loads — but "where does my bridged conversation show up in the list,
// and what is it called" is the first thing a user actually experiences.
//
// Usage: node scripts/probe-picker.mjs [claude|codex]
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();
const stripAnsi = (s) =>
  s
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\][^]*(?:|\\)/g, "")
    .replace(/[()][A-Za-z0-9]/g, "");

async function runInPty({ command, args, cwd, logPath, settleSeconds }) {
  const runner = new URL("./pty-run.exp", import.meta.url).pathname;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE|CODEX)/.test(k)),
  );
  await new Promise((resolve) => {
    const child = spawn("expect", [runner, logPath, String(settleSeconds), command, ...args], {
      cwd,
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  return stripAnsi(await readFile(logPath, "utf8").catch(() => ""));
}

const artifacts = await mkdtemp(join(tmpdir(), "turnbridge-picker-"));
const which = process.argv[2] ?? "all";
const cleanup = [];

// ---------------------------------------------------------------- claude (G7)
async function probeClaudeTitles() {
  const AI_TITLE = `ZTITLE${RUN}`;
  const FIRST_MSG_TITLED = `ZFIRSTMSGTITLED${RUN}`;
  const FIRST_MSG_PLAIN = `ZFIRSTMSGPLAIN${RUN}`;

  const cwd = await realpath(await mkdtemp(join(tmpdir(), "turnbridge-picker-claude-")));
  const projectDir = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "projects",
    cwd.replace(/[^A-Za-z0-9]/g, "-"),
  );
  await mkdir(projectDir, { recursive: true });
  cleanup.push(projectDir, cwd);

  const line = (sessionId, uuid, parentUuid, type, text, ts) => ({
    parentUuid,
    isSidechain: false,
    userType: "external",
    entrypoint: "cli",
    cwd,
    sessionId,
    version: "2.1.220",
    type,
    message:
      type === "assistant"
        ? {
            model: "probe",
            id: `msg_${uuid.slice(0, 8)}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        : { role: "user", content: [{ type: "text", text }] },
    uuid,
    timestamp: ts,
  });

  async function writeSession({ withAiTitle, firstMessage }) {
    const id = crypto.randomUUID();
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const lines = [
      line(id, u1, null, "user", firstMessage, "2026-07-27T10:00:00.000Z"),
      line(id, u2, u1, "assistant", "Understood.", "2026-07-27T10:00:01.000Z"),
    ];
    // cosmetic line type, per §4 — placed last so it cannot break the
    // parentUuid walk that reconstructs history from the final line
    if (withAiTitle) lines.push({ type: "ai-title", aiTitle: AI_TITLE, sessionId: id });
    await writeFile(
      join(projectDir, `${id}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    return id;
  }

  const titled = await writeSession({ withAiTitle: true, firstMessage: FIRST_MSG_TITLED });
  const plain = await writeSession({ withAiTitle: false, firstMessage: FIRST_MSG_PLAIN });

  const out = await runInPty({
    command: "claude",
    args: ["--resume"],
    cwd,
    logPath: join(artifacts, "claude-picker.log"),
    settleSeconds: 25,
  });
  await writeFile(join(artifacts, "claude-picker.stripped.txt"), out);

  const sawAiTitle = out.includes(AI_TITLE);
  const sawTitledFirstMsg = out.includes(FIRST_MSG_TITLED);
  const sawPlainFirstMsg = out.includes(FIRST_MSG_PLAIN);
  console.log(`\n[claude picker] sessions: titled=${titled.slice(0, 8)} plain=${plain.slice(0, 8)}`);
  console.log(`  ai-title rendered:                ${sawAiTitle}`);
  console.log(`  first user msg (has ai-title):    ${sawTitledFirstMsg}`);
  console.log(`  first user msg (no ai-title):     ${sawPlainFirstMsg}`);
  const verdict = sawAiTitle
    ? sawTitledFirstMsg
      ? "both ai-title AND first message rendered"
      : "ai-title WINS over first message (spec inference confirmed)"
    : sawTitledFirstMsg || sawPlainFirstMsg
      ? "first user message is the title source; ai-title NOT used"
      : "INCONCLUSIVE — picker did not render either marker";
  console.log(`  => ${verdict}`);
  return { probe: "claude-picker-title", verdict, sawAiTitle, sawTitledFirstMsg, sawPlainFirstMsg };
}

// ----------------------------------------------------------------- codex (G8)
async function probeCodexCwdFilter() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "turnbridge-picker-codex-")));
  const sub = join(cwd, "nested");
  await mkdir(sub, { recursive: true });
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "turnbridge-picker-other-")));
  cleanup.push(cwd, elsewhere);

  const sessionsRoot = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const dir = join(
    sessionsRoot,
    String(now.getFullYear()),
    p(now.getMonth() + 1),
    p(now.getDate()),
  );
  await mkdir(dir, { recursive: true });

  async function writeRollout(label, metaCwd) {
    const id = crypto.randomUUID();
    const marker = `ZCODEX${label}${RUN}`;
    const ts = "2026-07-27T10:00:00.000Z";
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
    const path = join(dir, `rollout-${stamp}-${id}.jsonl`);
    const lines = [
      {
        timestamp: ts,
        type: "session_meta",
        payload: {
          id,
          session_id: id,
          timestamp: ts,
          cwd: metaCwd,
          originator: "codex-tui",
          cli_version: "0.145.0",
          source: "cli",
          thread_source: "user",
          model_provider: "openai",
          history_mode: "legacy",
        },
      },
      {
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "user_message",
          message: marker,
          images: [],
          local_images: [],
          text_elements: [],
        },
      },
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] },
      },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    cleanup.push(path);
    return marker;
  }

  const exact = await writeRollout("EXACT", cwd);
  const nested = await writeRollout("NESTED", sub);
  const other = await writeRollout("OTHER", elsewhere);

  const filtered = await runInPty({
    command: "codex",
    args: ["resume"],
    cwd,
    logPath: join(artifacts, "codex-picker.log"),
    settleSeconds: 20,
  });
  await writeFile(join(artifacts, "codex-picker.stripped.txt"), filtered);

  const all = await runInPty({
    command: "codex",
    args: ["resume", "--all"],
    cwd,
    logPath: join(artifacts, "codex-picker-all.log"),
    settleSeconds: 20,
  });
  await writeFile(join(artifacts, "codex-picker-all.stripped.txt"), all);

  const seen = (hay, m) => hay.includes(m);
  console.log(`\n[codex picker] default (cwd=${cwd})`);
  console.log(`  exact-cwd session:   ${seen(filtered, exact)}`);
  console.log(`  nested-cwd session:  ${seen(filtered, nested)}`);
  console.log(`  other-cwd session:   ${seen(filtered, other)}`);
  console.log(`[codex picker] --all`);
  console.log(`  exact-cwd session:   ${seen(all, exact)}`);
  console.log(`  nested-cwd session:  ${seen(all, nested)}`);
  console.log(`  other-cwd session:   ${seen(all, other)}`);

  let match = "INCONCLUSIVE";
  if (seen(filtered, exact) && !seen(filtered, other)) {
    match = seen(filtered, nested) ? "prefix match (subdirs included)" : "exact string match";
  } else if (seen(filtered, exact) && seen(filtered, other)) {
    match = "no cwd filtering observed by default";
  }
  console.log(`  => default filter: ${match}`);
  console.log(
    `  => --all lifts filter: ${seen(all, other) && !seen(filtered, other) ? "yes" : seen(all, other) ? "n/a (never filtered)" : "no"}`,
  );
  return { probe: "codex-picker-cwd", match };
}

const results = [];
try {
  if (which === "all" || which === "claude") results.push(await probeClaudeTitles());
  if (which === "all" || which === "codex") results.push(await probeCodexCwdFilter());
} finally {
  console.log(`\nartifacts (rendered picker captures): ${artifacts}`);
  if (process.env.PROBE_KEEP !== "1") {
    for (const path of cleanup) await rm(path, { recursive: true, force: true });
    console.log("cleaned up fabricated sessions");
  }
}
console.log(`\n--- summary ---\n${results.map((r) => JSON.stringify(r)).join("\n")}`);
