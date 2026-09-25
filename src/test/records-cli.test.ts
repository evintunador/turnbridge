import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { asLedger, git, NOTES_REF, readEvents } from "conversation-ledger";
import { recordContinuation } from "../lineage.js";
import { cleanupRepo, makeTempRepo } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: "",
    env: { ...process.env, CODEX_SANDBOX: "1" },
  });
}

test("records CLI uses cledger's exact namespace and does not add transport wiring", async () => {
  const repo = await makeTempRepo("turnbridge-records-namespace-");
  try {
    const ledger = asLedger(repo);
    assert.equal(ledger.ns.name, "conversation-ledger");
    assert.equal(ledger.ns.incomingName, "cledger-incoming");
    assert.equal(ledger.ns.internalEnvName, "CLEDGER_INTERNAL");
    assert.equal(ledger.ns.stateDirName, "conversation-ledger");
    assert.equal(ledger.ns.configFile, ".cledger.json");
    assert.equal(ledger.ns.userConfigDir, "cledger");
    assert.equal(ledger.ns.cliName, "cledger");
    assert.match(ledger.ns.hookInvocation?.cli ?? "", /conversation-ledger\/dist\/cli\.js$/);
    assert.equal(NOTES_REF, "refs/notes/conversation-ledger");

    await git(["remote", "add", "origin", repo.root], { cwd: repo.root });
    await recordContinuation(repo, {
      source: "claude-code:source",
      target: "codex:target",
      importedThroughSeq: 1,
      targetCli: "codex",
      version: "test",
    });
    const events = await readEvents(repo, { kind: "continuation", tool: "turnbridge" });
    assert.equal(events.length, 1);
    const refsBefore = await git(["for-each-ref", "--format=%(refname)", "refs/notes"], { cwd: repo.root });
    const hookPath = join(repo.commonDir, "hooks", "pre-push");
    const hookBefore = await readFile(hookPath, "utf8");
    const fetchBefore = await git(["config", "--get-all", "remote.origin.fetch"], { cwd: repo.root });
    assert.match(hookBefore, /cledger.*transport-push|conversation-ledger\/dist\/cli\.js/);
    assert.doesNotMatch(hookBefore, /turnbridge/);
    assert.match(fetchBefore, /refs\/notes\/conversation-ledger:refs\/notes\/cledger-incoming/);

    assert.equal(run(repo.root, ["records", "--help"]).status, 0);
    assert.equal(run(repo.root, ["records", "bogus"]).status, 2);
    assert.equal(run(repo.root, ["transport-push"]).status, 1);
    const transport = run(repo.root, ["records", "transport-push"]);
    assert.equal(transport.status, 2);
    assert.match(transport.stderr, /use cledger transport-push/);
    assert.equal(run(repo.root, ["annals", "sync"]).status, 1);
    assert.equal(await git(["for-each-ref", "--format=%(refname)", "refs/notes"], { cwd: repo.root }), refsBefore);
    assert.equal(await readFile(hookPath, "utf8"), hookBefore);
    assert.equal(await git(["config", "--get-all", "remote.origin.fetch"], { cwd: repo.root }), fetchBefore);
  } finally {
    await cleanupRepo(repo);
  }
});

test("canonical records commands and aliases share routing, output, and exit codes", async () => {
  const repo = await makeTempRepo("turnbridge-records-routing-");
  try {
    const help = run(repo.root, ["records", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: turnbridge records <command>/);
    const cases: Array<[string, string, string[]]> = [
      ["sync", "sync", ["--fetch-only", "--push-only"]],
      ["review", "review", []],
      ["inspect", "inspect", ["--output", "ignored.txt"]],
      ["redact", "redact", ["example", "--all"]],
      ["allow", "allow", ["000000000000"]],
      ["reanchor", "reanchor", ["manual", "HEAD", "--onto", "HEAD"]],
      ["re-anchor", "reanchor", ["manual", "HEAD", "--onto", "HEAD"]],
    ];
    for (const [alias, canonical, args] of cases) {
      const direct = run(repo.root, ["records", canonical, ...args]);
      const shortcut = run(repo.root, [alias, ...args]);
      assert.equal(shortcut.status, direct.status, alias);
      assert.equal(shortcut.stdout, direct.stdout, alias);
      assert.equal(shortcut.stderr, direct.stderr, alias);
      if (canonical === "sync") assert.equal(direct.status, 2);
      else {
        assert.equal(direct.status, 1);
        assert.match(direct.stderr, /refuses inside an agent session/);
      }
    }
    const unknown = run(repo.root, ["records", "bogus"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^turnbridge records: unknown records command/);
    assert.equal(run(repo.root, ["records", "sync", "--bad-option"]).status, 2);
  } finally {
    await cleanupRepo(repo);
  }
});

test("agent-only safety refusals preserve runtime exit code", async () => {
  const repo = await makeTempRepo("turnbridge-records-safety-");
  try {
    const blocked = run(repo.root, ["records", "sync", "--no-scan", "--push-only"]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /refuses inside an agent session/);
    const fetch = run(repo.root, ["records", "sync", "missing", "--fetch-only", "--no-scan"]);
    assert.equal(fetch.status, 0);
    assert.doesNotMatch(fetch.stderr, /refuses inside an agent session/);
  } finally {
    await cleanupRepo(repo);
  }
});
