import type { CliName, ConversationSummary } from "../types.js";

/** A concrete command to hand the terminal over to. */
export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  /** Shown to the user before launch (session type honesty, warnings). */
  notes: string[];
  /**
   * Ledger conversation id the fabricated session will be captured under
   * (`<source>:<generated-session-id>`), when this plan fabricated one. The
   * generated id is preserved across the target's native resume, so it is a
   * stable anchor for recording source→target lineage.
   */
  fabricatedConversationId?: string;
}

export interface TargetAdapter {
  name: CliName;
  /** Executable name looked up on PATH. */
  binary: string;
  isInstalled(): Promise<boolean>;
  /** Native resume for a conversation that originated in this CLI. */
  nativeResume(sessionId: string, cwd: string): LaunchPlan;
  /**
   * Fabricate a native session file from canonical events so this CLI's own
   * resume loads it, then return the resume plan. Version-pinned; throws
   * FabricationUnsupportedError when the installed CLI version is unverified.
   */
  fabricate(summary: ConversationSummary, cwd: string): Promise<LaunchPlan>;
  /** Honest fallback: fresh session instructed to read the transcript file. */
  bootstrap(summary: ConversationSummary, cwd: string, transcriptPath: string): LaunchPlan;
}

export class FabricationUnsupportedError extends Error {
  constructor(
    message: string,
    public readonly cliName: CliName,
  ) {
    super(message);
  }
}
