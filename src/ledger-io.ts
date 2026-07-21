/**
 * conversation-ledger reads perform lazy maintenance — absorbing fetched
 * transport refs and auto re-anchoring after squash/rebase rewrites — and
 * report it by writing directly to stderr. Left alone, those notices can
 * interleave with turnbridge's own stderr-rendered picker UI mid-line.
 */

type StderrWrite = typeof process.stderr.write;

/**
 * Run ledger calls with stderr buffered, then re-emit everything the ledger
 * wrote as one contiguous block (flushed even when `fn` throws). Callers
 * should invoke this before any picker rendering so notices land above the
 * list, not inside it.
 */
export async function withLedgerNotices<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.stderr.write.bind(process.stderr) as StderrWrite;
  let buffered = "";
  const capture: StderrWrite = (chunk, encodingOrCb?, cb?) => {
    buffered +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encodingOrCb === "string" ? encodingOrCb : undefined,
          );
    const done = (typeof encodingOrCb === "function" ? encodingOrCb : cb) as
      | ((err?: Error | null) => void)
      | undefined;
    if (done) done();
    return true;
  };
  process.stderr.write = capture;
  try {
    return await fn();
  } finally {
    process.stderr.write = original;
    if (buffered) original(buffered.endsWith("\n") ? buffered : buffered + "\n");
  }
}
