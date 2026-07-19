import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvents,
  findRepo,
  git,
  type EventDraft,
  type RepoInfo,
} from "conversation-ledger";

export async function makeTempRepo(prefix = "turnbridge-test-"): Promise<RepoInfo> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  await git(["config", "user.email", "test@example.com"], { cwd: dir });
  await git(["config", "user.name", "Test User"], { cwd: dir });
  await git(["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "test\n");
  await git(["add", "."], { cwd: dir });
  await git(["commit", "-q", "-m", "init"], { cwd: dir });
  const repo = await findRepo(dir);
  if (!repo) throw new Error("failed to init temp repo");
  return repo;
}

export async function cleanupRepo(repo: RepoInfo): Promise<void> {
  await rm(repo.root, { recursive: true, force: true });
}

export interface TurnSpec {
  role: "user" | "assistant";
  text: string;
  seq: number;
  email?: string;
  display?: string;
  occurredAt?: string;
}

export function turnDraft(conversationId: string, source: string, spec: TurnSpec): EventDraft {
  const isHuman = spec.role === "user";
  const actor: EventDraft["actor"] = isHuman
    ? {
        type: "human",
        ...(spec.email ? { id: spec.email } : {}),
        ...(spec.display ? { display: spec.display } : {}),
      }
    : { type: "agent", id: "test-model" };
  return {
    kind: "conversation_turn",
    occurred_at: spec.occurredAt ?? `2026-01-01T00:00:${String(spec.seq).padStart(2, "0")}.000Z`,
    actor,
    producer: {
      tool: "turnbridge-test",
      source,
      session_id: conversationId.split(":").slice(1).join(":"),
    },
    conversation: { id: conversationId, seq: spec.seq },
    content: { role: spec.role, blocks: [{ type: "text", text: spec.text }] },
  };
}

export async function seedConversation(
  repo: RepoInfo,
  conversationId: string,
  source: string,
  turns: TurnSpec[],
): Promise<void> {
  await appendEvents(
    repo,
    turns.map((t) => turnDraft(conversationId, source, t)),
  );
}
