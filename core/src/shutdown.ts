// Graceful-shutdown drain for in-flight metered requests, extracted from proxy.ts so it's unit-testable
// (clock, sleep, and the "handlers returned" signal are injected — no real server, no real time, no
// process.exit). The handler registers each live STREAM's settle() in `inflight` (handler.ts); a buffered
// request isn't tracked there (it has no metered partial until its upstream response lands).
//
// WHY THIS EXISTS / the bug it fixes: the old shutdown raced `server.stop()` against the grace deadline and
// only force-settled `inflight` if the DEADLINE won. But `server.stop()` resolves when request HANDLERS
// return, and a streaming handler returns its Response immediately while the body keeps pumping — so
// `server.stop()` reported "drained" in <1s with streams still live, the force-settle branch was skipped,
// and those streams were abandoned to boot recovery's FULL refund instead of being billed their delivered
// partial. We therefore wait on the AUTHORITATIVE signal (the `inflight` set emptying) AND on handlers
// returning (buffered requests finishing), up to the grace window, then ALWAYS force-settle any straggler
// stream — billing its metered partial, refunding the rest — so a restart charges for output already
// delivered. Buffered stragglers stay full-refunded on the next boot (correct: nothing was delivered).
export type DrainOpts = {
  inflight: Set<(reason?: "drain") => Promise<void>>; // live settlement promises; removed only after durable completion
  handlersReturned: Promise<unknown>; // server.stop(): resolves once request handlers return (buffered done)
  graceMs: number; // wait at most this long for natural completion before force-settling
  now: () => number; // injected clock (Date.now in prod)
  sleep: (ms: number) => Promise<void>; // injected poll delay (setTimeout in prod)
  pollMs?: number; // how often to re-check the drain signals (default 50ms)
  onSettleError?: (err: unknown) => void; // a straggler's settle() threw (logged by the caller; never rethrown)
};

// Returns how many streams were successfully force-settled at the deadline (0 = everything finished
// naturally / nothing was in flight). Caller does the hard close + process.exit afterwards.
export async function drainInflight(opts: DrainOpts): Promise<{ forceSettled: number }> {
  const pollMs = opts.pollMs ?? 50;
  let handlersDone = false;
  // Either resolution counts as "handlers returned" — a rejected stop still means we should stop waiting on it.
  opts.handlersReturned.then(
    () => { handlersDone = true; },
    () => { handlersDone = true; },
  );
  const deadline = opts.now() + opts.graceMs;
  // Wait until BOTH buffered handlers have returned AND no stream is still live — or the grace runs out.
  while ((!handlersDone || opts.inflight.size > 0) && opts.now() < deadline) {
    await opts.sleep(pollMs);
  }
  // Snapshot first: settle() mutates `inflight` as it completes. Start every settlement before awaiting so
  // one slow ledger call cannot delay its siblings. A single rejection cannot strand the others or abort
  // this function — an uncaught rejection here would skip
  // the caller's hard close + process.exit, letting systemd SIGKILL the survivors into a boot-recovery FULL
  // refund (the exact failure this drain exists to prevent). settle() is at-most-once + idempotent, so a
  // straggler that already settled naturally is a safe no-op.
  const stragglers = [...opts.inflight];
  const results = await Promise.allSettled(stragglers.map((settle) => settle("drain")));
  let forceSettled = 0;
  for (const result of results) {
    if (result.status === "fulfilled") forceSettled += 1;
    else opts.onSettleError?.(result.reason);
  }
  return { forceSettled };
}
