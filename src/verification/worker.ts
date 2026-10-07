import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendEvents, findRepo, type EvidenceEvent } from "conversation-ledger";
import { listConversations } from "../conversations.js";
import { targets } from "../targets/index.js";
import { buildPlan } from "../resume.js";
import { readLineage } from "../lineage.js";
import { reconcileBootstrapContinuations } from "../bootstrap-lineage.js";
import { turnContent, type CliName, type ConversationSummary } from "../types.js";
import { runProcess } from "./process.js";
import { runPty, type PtyAction } from "./pty.js";
import type { LocalModelConfig } from "./local-model.js";
import { startBridgeProvider } from "./provider.js";
import { configureScriptedTarget, TERMINAL_SYNTAX } from "./configure.js";
import { terminalScreen } from "./screen.js";
import { requiredGates, type BridgeMode, type Gate } from "./matrix.js";

export interface WorkerOptions {
  root: string; target: CliName; source: CliName; mode: BridgeMode; cledger: string;
  sourceFile?: string; timeoutMs?: number; localModel?: LocalModelConfig;
}
export interface SourceSnapshot {
  summary: ConversationSummary; version: string; historyMarker: string; assistantMarker: string;
  proof: "installed-capture"; artifacts: string[]; ledgerEvents?: EvidenceEvent[];
}

function linkedRead(events: EvidenceEvent[], secret: string): boolean {
  const blocks = events.flatMap(event => turnContent(event)?.blocks ?? []);
  const nativeReads = new Set(events.filter(event => {
    const content = event.content as Record<string, unknown>;
    return content.event_type === "file.operation" && content.method === "read_text" && String(content.path).endsWith("evidence.txt");
  }).map(event => (event.content as Record<string, unknown>).call_id));
  if (events.some(event => {
    const content = event.content as Record<string, unknown>;
    return content.event_type === "file.result" && nativeReads.has(content.call_id) && content.error === undefined && JSON.stringify(content.attachment).includes(secret);
  })) return true;
  const calls = new Set(blocks.filter(block => block.type === "tool_use" && typeof block.id === "string" && JSON.stringify(block.input).includes("evidence.txt")).map(block => block.id));
  return blocks.some(block => block.type === "tool_result" && calls.has(block.tool_use_id) && block.is_error !== true && JSON.stringify(block.content).includes(secret));
}

export function capturedCompletion(events: EvidenceEvent[], secret: string): boolean {
  return events.some(event => {
    const content = turnContent(event);
    if (content?.role !== "assistant") return false;
    const text = content.blocks.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("");
    return text.includes("TB_DONE") && text.includes(secret);
  });
}

export async function verifyInstalledBridge(options: WorkerOptions) {
  const { root, target: name, mode } = options;
  const repoPath = join(root, "repo"), reportPath = join(root, "report.json");
  const report = { schema: "turnbridge-installed/1", source: options.source, target: name, mode, platform: process.platform,
    terminal: "interactive", tier: options.localModel?.tier ?? (options.localModel ? "local-model" : "scripted"), sourceProof: options.sourceFile ? "installed-capture" : "canonical-fixture",
    certification: options.sourceFile ? "installed-bridge" : "installed-target-smoke",
    sourceVersion: "fixture", targetVersion: "unknown", status: "blocked", gates: {} as Partial<Record<Gate, boolean>>, reason: "", artifacts: [] as string[],
    observedAt: new Date().toISOString(), exclusions: [...(options.localModel ? [] : ["live model/provider behavior"]), ...(name === "kilo" ? ["filesystem snapshots/checkpoints (disabled in the isolated read-only fixture)"] : []), "full visual layout certification", "other CLI versions", "other operating systems"] };
  let provider: Awaited<ReturnType<typeof startBridgeProvider>> | undefined;
  const checked = async (command: string, args: string[], timeoutMs = 20_000) => {
    const result = await runProcess(command, args, { cwd: repoPath, env: process.env, timeoutMs });
    if (result.code !== 0 || result.timedOut) throw Error(`${command} ${args[0]} failed: ${result.stderr.slice(-2000)}`);
    return result.stdout;
  };
  try {
    await mkdir(repoPath, { recursive: true });
    await checked("git", ["init", "-q", "-b", "main"]);
    await writeFile(join(repoPath, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    await writeFile(join(repoPath, "README.md"), "Turnbridge disposable installed bridge verification\n");
    await checked("git", ["add", "."]); await checked("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
    const repo = (await findRepo(repoPath))!;
    let sourceId: string | undefined;
    let historyMarker = `TB_HISTORY_${randomUUID()}`, assistantMarker = `TB_ASSISTANT_${randomUUID()}`;
    if (options.sourceFile) {
      const snapshot = JSON.parse(await readFile(options.sourceFile, "utf8")) as SourceSnapshot;
      if (snapshot.proof !== "installed-capture" || snapshot.summary.source !== options.source) throw Error("Source snapshot does not establish installed capture for this CLI");
      sourceId = snapshot.summary.id;
      historyMarker = snapshot.historyMarker; assistantMarker = snapshot.assistantMarker; report.sourceVersion = snapshot.version;
      await appendEvents(repo, (snapshot.ledgerEvents ?? snapshot.summary.events).map(({ id, schema, recorded_at, ...draft }) => draft));
    } else {
      const sessionId = randomUUID(), id = `${options.source}:${sessionId}`;
      await appendEvents(repo, [
        { kind: "conversation_turn", occurred_at: "2026-01-01T00:00:00.000Z", actor: { type: "human" }, producer: { tool: "turnbridge-fixture", source: options.source, session_id: sessionId }, stream: { id, seq: 0 },
          content: { role: "user", blocks: [{ type: "text", text: `${historyMarker}\nUnicode café 日本語 🦉\n- item one\n- item two\n\n\`\`\`js\nconsole.log('history');\n\`\`\`` }] } },
        { kind: "conversation_turn", occurred_at: "2026-01-01T00:00:01.000Z", actor: { type: "agent" }, producer: { tool: "turnbridge-fixture", source: options.source, session_id: sessionId }, stream: { id, seq: 1 },
          content: { role: "assistant", blocks: [{ type: "thinking", text: "Recorded visible thought." }, { type: "text", text: assistantMarker }] } },
      ]);
    }
    const sources = await listConversations(repo, { all: true });
    const summary = sourceId ? sources.find(summary => summary.id === sourceId) : sources[0];
    if (!summary) throw Error("Configured captured source conversation is absent from its ledger snapshot");
    provider = await startBridgeProvider(name, historyMarker, options.localModel);
    provider.state.evidencePath = join(repoPath, "evidence.txt");
    const flags = await configureScriptedTarget(name, root, repoPath, provider.endpoint);
    const target = targets[name];
    let version: string;
    try { version = name === "aider" && process.env.TURNBRIDGE_AIDER_PYTHON ? await checked(process.env.TURNBRIDGE_AIDER_PYTHON, ["-m", "aider", "--version"]) : await checked(target.binary, ["--version"]); }
    catch (error) { report.reason = `cli-unavailable: ${String(error)}`; return report; }
    report.targetVersion = version.match(/\d+\.\d+\.\d+/)?.[0] ?? version.trim();
    if (name === "cline") await checked(target.binary, ["auth", "openai-compatible", "--apikey", "TESTONLY-local", "--modelid", "fixture", "--baseurl", provider.endpoint + "/v1"]);
    if (name === "kiro" || name === "cursor") { report.reason = "Scripted installed bridge driver requires an available isolated provider/auth route"; return report; }
    if (mode === "native-import" && target.supportsNativeImport === false) { report.status = "unsupported"; report.reason = "Native import unavailable; bootstrap is a separate supported route"; return report; }
    await checked(process.execPath, [options.cledger, "install", name]);
    process.chdir(repoPath);
    const lineage = await readLineage(repo, true);
    const plan = await buildPlan(repo, target, summary, repoPath, mode === "bootstrap", lineage, sources, false);
    if (mode === "native-import" && !plan.fabricatedConversationId) { report.status = "unsupported"; report.reason = "Installed version cannot fabricate native history; planner selected bootstrap"; return report; }
    provider.state.transcriptPath = plan.notes.find(note => note.startsWith("transcript: "))?.slice("transcript: ".length) ?? "";
    // Use the designated foundation's public ledger read API: large native system
    // records can exceed bounded subprocess stdout. This never performs backfill.
    const foundation = await import(pathToFileURL(join(dirname(options.cledger), "index.js")).href);
    const exportEvents = async (): Promise<EvidenceEvent[]> => foundation.readEvents(repo);
    const ownEvents = (events: EvidenceEvent[]) => events.filter(event => event.producer.source === name && event.stream?.id !== summary.id);
    let normalExit = true, firstTarget: ConversationSummary | undefined;
    for (let round = 0; round < 2; round++) {
      const contextStart = provider.state.contexts.length;
      const secret = `TB_FILE_${randomUUID()}`;
      const previousSecret = provider.state.secret;
      provider.state.secret = secret;
      await writeFile(join(repoPath, "evidence.txt"), secret + "\n", { mode: 0o600 });
      const completion = join(root, `round-${round}-complete`), trace = join(root, `round-${round}-terminal.log`);
      let stopped = false;
      const observer = (async () => {
        while (!stopped) {
          try {
            const events = ownEvents(await exportEvents());
            // Some CLIs flush the final assistant record only during SessionEnd.
            // A real linked read plus completed inference permits graceful exit;
            // final automatic capture is evaluated after native hooks finish.
            if (linkedRead(events, secret) && provider!.state.completedSecrets.includes(secret)) {
              await writeFile(completion, "automatic linked capture observed"); return;
            }
          } catch { /* bounded export can overlap an incremental hook write */ }
          await new Promise(done => setTimeout(done, 250));
        }
      })();
      const native = round === 0 ? plan : target.nativeResume(firstTarget!.sessionId, repoPath);
      // Test-only flags are placed before positional prompts and after subcommands.
      const args = [...native.args];
      const insert = args[0] === "resume" || args[0] === "session" ? 1 : 0;
      if (native.command === "cledger") args.push(...flags); else args.splice(insert, 0, ...flags);
      const actions: PtyAction[] = [];
      if (name === "gemini-cli" && mode === "bootstrap" && round === 0) actions.push({ waitFor: "untrusted directories", send: "\r" });
      if (name === "crush" && round === 0) actions.push({ waitFor: "Would you like to initialize", send: "n" });
      if (name === "kimi" && round === 0) actions.push({ waitFor: "Trust this folder", send: "\r" });
      // Viewing controls never alter the imported history or manufacture it.
      // Claude's transcript viewer writes full history to native scrollback;
      // OpenCode's configured native controls expand tool output for inspection.
      if (mode === "native-import" && round === 0 && name === "claude-code") actions.push(
        { waitFor: TERMINAL_SYNTAX[name].ready, send: "\x0f", delayMs: 1000 },
        { waitFor: "^", send: "[", delayMs: 750 }, { waitFor: "^", send: "\x1b", delayMs: 750 });
      if (mode === "native-import" && round === 0 && (name === "opencode" || name === "kilo")) actions.push(
        { waitFor: TERMINAL_SYNTAX[name].ready, send: "\x0f", delayMs: 750 },
        { waitFor: "^", send: "\x19", delayMs: 750 }, { waitFor: "^", send: "\x07", delayMs: 750 });
      const viewed = mode === "native-import" && round === 0 && ["claude-code", "opencode", "kilo"].includes(name);
      if (!native.initialInput && (round > 0 || mode === "native-import")) {
        const promptMarker = `TB_NEW_${randomUUID().slice(0, 8)}`;
        const bracketedPaste = ["claude-code", "codex", "gemini-cli", "kimi", "open-interpreter", "goose"].includes(name);
        // Gemini publishes a Ready title before asynchronously restoring the
        // resumed messages. Wait for that session's actual last answer first.
        // Viewing already established readiness; a retained footer may not be
        // repainted after scrolling, so do not wait for the same bytes again.
        const ready = viewed ? "^" : name === "gemini-cli" && round > 0 ? "TB_DONE[\\s\\S]*" + previousSecret + "[\\s\\S]*Type your message" : TERMINAL_SYNTAX[name].ready;
        actions.push({ waitFor: ready, send: `${promptMarker}. Read evidence.txt and report its exact contents; use the imported conversation as context.`, paste: bracketedPaste, delayMs: 1000 });
        // Readline-style editors may repaint one inserted character per cursor
        // move, so their raw echo need not contain the complete marker.
        actions.push({ waitFor: bracketedPaste ? promptMarker : "^", send: "\r", delayMs: 1000 });
      }
      if (name === "openhands") actions.push({ waitFor: "^", waitForPath: completion, send: "\x11", delayMs: 750 });
      else if (name === "crush") actions.push({ waitFor: "TB_DONE[\\s\\S]*" + secret, waitForPath: completion, send: "\x03", delayMs: 500 }, { waitFor: "Are you sure you want to quit", send: "y" });
      else if (name === "cline") actions.push({ waitFor: "^", waitForPath: completion, send: "/exit\r", paste: true, delayMs: 1000 });
      else actions.push({ waitFor: "TB_DONE[\\s\\S]*" + secret + (name === "gemini-cli" ? "[\\s\\S]*Ready \\(repo\\)" : ""), waitForPath: completion, send: TERMINAL_SYNTAX[name].quit, delayMs: 1000 },
        { waitFor: name === "gemini-cli" ? "Exit the cli" : "^", send: "\r", delayMs: 1000 });
      let terminal;
      let launchCommand = native.command, launchArgs = args;
      if (native.initialInput) {
        const launchFile = join(root, `round-${round}-launch.json`);
        await writeFile(launchFile, JSON.stringify({ ...native, args }), { mode: 0o600 });
        launchCommand = process.execPath;
        launchArgs = [fileURLToPath(new URL("./launch.js", import.meta.url)), launchFile];
      }
      try { terminal = await runPty(launchCommand, launchArgs, { cwd: repoPath, env: process.env, timeoutMs: options.timeoutMs ?? 60_000, transcriptPath: trace,
        answerTerminalQueries: name !== "opencode" && name !== "kilo", stopWhen: name === "droid" ? "Log in to Factory|Log in to get started|Please login with your Factory account" : "(?!)", actions }); }
      finally { stopped = true; await observer; }
      if (name === "droid" && /Log in to Factory|Log in to get started|Please login with your Factory account/.test(terminal.output)) { report.reason = "login-required: disposable profile has no Factory account credential"; return report; }
      await writeFile(join(root, `round-${round}-terminal-result.json`), JSON.stringify({ ...terminal, output: undefined }, null, 2));
      normalExit &&= terminal.code === 0 && !terminal.timedOut && terminal.actionsCompleted === actions.length;
      const screen = await terminalScreen(terminal.output, [historyMarker, assistantMarker]);
      await writeFile(join(root, `round-${round}-screen.svg`), screen.svg);
      await writeFile(join(root, `round-${round}-screen.txt`), screen.text);
      await writeFile(join(root, `round-${round}-rendered-markers.json`), JSON.stringify(screen.markerFrames, null, 2));
      report.artifacts.push(trace, join(root, `round-${round}-screen.svg`), join(root, `round-${round}-terminal-result.json`));
      if ((!terminal.timedOut && [-11, -6].includes(terminal.code)) || /pointer being freed was not allocated|Bun has crashed|Segmentation fault/.test(terminal.output)) {
        report.status = "blocked"; report.reason = `Installed native runtime crashed (exit ${terminal.code}); artifacts retain signal status and any allocator/panic output`; return report;
      }
      let events = ownEvents(await exportEvents());
      const captureDeadline = Date.now() + 12_000;
      while (normalExit && Date.now() < captureDeadline && !capturedCompletion(events, secret)) {
        await new Promise(done => setTimeout(done, 250)); events = ownEvents(await exportEvents());
      }
      await writeFile(join(root, `round-${round}-events.json`), JSON.stringify(events, null, 2));
      report.artifacts.push(join(root, `round-${round}-events.json`));
      if (round === 0) {
        report.gates.modelContext = provider.state.modelContext;
        report.gates.newToolUse = linkedRead(events, secret);
        report.gates.automaticCapture = linkedRead(events, secret) && capturedCompletion(events, secret);
        report.gates.historyRendering = mode === "native-import" && [historyMarker, assistantMarker].every(marker => screen.observedMarkers.includes(marker));
        report.gates.bootstrapDisclosure = mode === "bootstrap" && plan.notes.some(note => note.includes("NEW"));
        await reconcileBootstrapContinuations(repo);
        const graph = await readLineage(repo, true);
        const convs = await listConversations(repo, { all: true });
        firstTarget = convs.find(conv => conv.source === name && conv.id !== summary.id && conv.events.some(event => JSON.stringify(event.content).includes(secret)));
        report.gates.lineage = !!firstTarget && graph.parentOf.get(firstTarget.id)?.source === summary.id;
        if (firstTarget && report.gates.automaticCapture) await writeFile(join(root, "source-snapshot.json"), JSON.stringify({ summary: firstTarget, version: report.targetVersion, historyMarker, assistantMarker,
          proof: "installed-capture", artifacts: report.artifacts, ledgerEvents: await exportEvents() } satisfies SourceSnapshot, null, 2));
        if (!firstTarget || !normalExit || !report.gates.automaticCapture || target.supportsNativeResume === false) break;
      } else {
        const resumed = events.filter(event => event.stream?.id === firstTarget!.id);
        report.gates.subsequentResume = linkedRead(resumed, secret) && capturedCompletion(resumed, secret) && provider.state.contexts.slice(contextStart).some(Boolean);
      }
    }
    report.gates.normalExit = normalExit;
    const captured = firstTarget ?? (await listConversations(repo, { all: true })).find(conv => conv.source === name && conv.id !== summary.id);
    if (captured && report.gates.automaticCapture) {
      await writeFile(join(root, "source-snapshot.json"), JSON.stringify({ summary: captured, version: report.targetVersion, historyMarker, assistantMarker,
        proof: "installed-capture", artifacts: report.artifacts, ledgerEvents: await exportEvents() } satisfies SourceSnapshot, null, 2));
    }
    if (target.supportsNativeResume === false) { report.status = "unsupported"; report.reason = "Exact-ID native resume is unavailable; inspect the individual bootstrap/capture gates"; return report; }
    report.status = requiredGates(mode).every(gate => report.gates[gate] === true) ? "pass" : "fail";
    if (report.status !== "pass") report.reason = "Unmet gates: " + requiredGates(mode).filter(gate => !report.gates[gate]).join(", ");
    if (provider.state.errors.length) report.reason += " Provider: " + provider.state.errors.join("; ");
  } catch (error) { report.status = "fail"; report.reason = String(error); await writeFile(join(root, "error.txt"), error instanceof Error ? error.stack ?? String(error) : String(error)); }
  finally {
    if (provider) { await writeFile(join(root, "provider-requests.json"), JSON.stringify(provider.state, null, 2)); report.artifacts.push(join(root, "provider-requests.json")); await provider.close(); }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(await readFile(process.argv[2]!, "utf8")) as WorkerOptions;
  const report = await verifyInstalledBridge(options);
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = report.status === "pass" || report.status === "unsupported" ? 0 : report.status === "blocked" ? 2 : 1;
}
