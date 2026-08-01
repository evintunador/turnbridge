import { findRepo, gitUserIdentity, type RepoInfo } from "conversation-ledger";
import { writeBootstrapTranscript } from "./bootstrap.js";
import { loadConfig, saveConfig } from "./config.js";
import { listConversations } from "./conversations.js";
import { recordContinuation, readLineage, type Lineage } from "./lineage.js";
import { runLaunchPlan } from "./launch.js";
import { withLedgerNotices } from "./ledger-io.js";
import { confirm, pickFromList } from "./picker.js";
import { installedTargets, targetFor } from "./targets/index.js";
import { formatSize } from "./transcript.js";
import { FabricationUnsupportedError, type LaunchPlan, type TargetAdapter } from "./targets/types.js";
import { cliLabel, type CliName, type ConversationSummary } from "./types.js";
import { turnbridgeVersion } from "./version.js";

export interface ResumeFlags {
  target?: CliName | undefined;
  all?: boolean;
  anyCommit?: boolean;
  bootstrap?: boolean;
  listOnly?: boolean;
  noReasoningReplay?: boolean;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Lineage annotation for a row: where it came from / where it was bridged. */
function lineageTag(summary: ConversationSummary, lineage: Lineage | undefined): string | null {
  if (!lineage) return null;
  const parent = lineage.parentOf.get(summary.id);
  if (parent) return `↳ continued from ${cliLabel(parent.source.split(":")[0] ?? "")}`;
  const children = lineage.childrenOf.get(summary.id);
  if (children && children.length > 0) {
    const latest = children.reduce((a, b) => (a.occurredAt > b.occurredAt ? a : b));
    return `→ bridged to ${cliLabel(latest.targetCli)} ${relativeTime(latest.occurredAt)}`;
  }
  return null;
}

export function renderConversationRow(
  summary: ConversationSummary,
  index: number,
  selfEmail: string | null,
  lineage?: Lineage,
): string {
  const owner =
    summary.owners.length === 0
      ? "author unknown"
      : summary.owners.every((o) => o === selfEmail)
        ? null
        : summary.ownerDisplays[0] ?? summary.owners[0]!;
  const parts = [
    `[${index + 1}]`,
    cliLabel(summary.source).padEnd(11),
    relativeTime(summary.lastActivity).padStart(8),
    `${summary.turnCount} turns`.padStart(9),
  ];
  if (owner) parts.push(`by ${owner}`);
  const tag = lineageTag(summary, lineage);
  if (tag) parts.push(tag);
  parts.push(`· ${summary.title}`);
  return parts.join("  ");
}

async function chooseTarget(flags: ResumeFlags): Promise<TargetAdapter | null> {
  if (flags.target) return targetFor(flags.target);
  const config = await loadConfig();
  if (config.defaultTarget) return targetFor(config.defaultTarget);

  const installed = await installedTargets();
  if (installed.length === 0) {
    process.stderr.write("turnbridge: no supported CLI found on PATH (claude, codex, opencode)\n");
    return null;
  }
  if (installed.length === 1) return installed[0]!;

  const choice = await pickFromList(
    installed,
    (t, i) => `[${i + 1}] ${cliLabel(t.name)}`,
    "Resume in which CLI?",
  );
  if (!choice) return null;
  if (await confirm(`Make ${cliLabel(choice.name)} your default target?`)) {
    await saveConfig({ ...(await loadConfig()), defaultTarget: choice.name });
    process.stderr.write(
      `turnbridge: default target saved (change via ~/.turnbridge/config.json)\n`,
    );
  }
  return choice;
}

async function buildPlan(
  repo: RepoInfo,
  target: TargetAdapter,
  summary: ConversationSummary,
  cwd: string,
  useBootstrap: boolean,
  lineage: Lineage,
  replayReasoning: boolean,
): Promise<LaunchPlan> {
  if (target.name === summary.source && !useBootstrap) {
    return target.nativeResume(summary.sessionId, cwd);
  }
  if (!useBootstrap) {
    try {
      const plan = await target.fabricate(summary, cwd, { replayReasoning });
      // re-bridging a conversation that already embeds imported history
      // re-copies that history into the new session — functional, just larger
      if (lineage.parentOf.has(summary.id)) {
        plan.notes.push(
          "note: this conversation already contains history imported by turnbridge; " +
            "bridging it again re-copies that history into the new session",
        );
      }
      if (plan.fabricatedConversationId) {
        const lastSeq = summary.events[summary.events.length - 1]?.conversation?.seq ?? 0;
        await recordContinuation(repo, {
          source: summary.id,
          target: plan.fabricatedConversationId,
          importedThroughSeq: lastSeq,
          targetCli: target.name,
          version: turnbridgeVersion(),
        });
      }
      return plan;
    } catch (err) {
      if (!(err instanceof FabricationUnsupportedError)) throw err;
      process.stderr.write(
        `turnbridge: ${err.message}; falling back to bootstrap rehydration\n`,
      );
    }
  }
  const transcript = await writeBootstrapTranscript(summary);
  const plan = target.bootstrap(summary, cwd, transcript.path);
  plan.notes.push(
    `transcript is ${formatSize(transcript.size)}; fitting it is the target CLI's own concern ` +
      "(both apply their own compaction or truncation), so this is reported, not enforced",
  );
  return plan;
}

export async function resumeCommand(flags: ResumeFlags): Promise<number> {
  const cwd = process.cwd();
  const repo = await findRepo(cwd);
  if (!repo) {
    process.stderr.write("turnbridge: not inside a git repository\n");
    return 1;
  }
  const identity = await gitUserIdentity(repo);
  // Sequential, not Promise.all: each ledger read may run lazy maintenance
  // (notes merge, re-anchor append) — concurrent calls race on the same
  // refs and cursor file. The second read's maintenance pass is a no-op.
  const [conversations, lineage] = await withLedgerNotices(async () => {
    const convs = await listConversations(repo, {
      all: flags.all ?? false,
      user: identity.email ?? undefined,
      anyCommit: flags.anyCommit ?? false,
    });
    return [convs, await readLineage(repo, flags.anyCommit ?? false)] as const;
  });

  if (conversations.length === 0) {
    process.stderr.write(
      "turnbridge: no captured conversations for this repo state.\n" +
        "  - capture runs via conversation-ledger hooks: `cledger install all`\n" +
        "  - `--any-commit` lists conversations from other branches/commits\n" +
        "  - `--all` includes collaborators' conversations\n",
    );
    return 1;
  }

  if (flags.listOnly) {
    conversations.forEach((c, i) =>
      process.stdout.write(renderConversationRow(c, i, identity.email, lineage) + "\n"),
    );
    return 0;
  }

  const summary = await pickFromList(
    conversations,
    (c, i) => renderConversationRow(c, i, identity.email, lineage),
    "Resume which conversation?",
  );
  if (!summary) return 0;

  const target = await chooseTarget(flags);
  if (!target) return 1;
  if (!(await target.isInstalled())) {
    process.stderr.write(`turnbridge: ${target.binary} is not on PATH\n`);
    return 1;
  }

  const config = await loadConfig();
  const replayReasoning = !flags.noReasoningReplay && config.reasoningReplay !== false;

  const plan = await buildPlan(
    repo,
    target,
    summary,
    cwd,
    flags.bootstrap ?? false,
    lineage,
    replayReasoning,
  );
  return runLaunchPlan(plan);
}
