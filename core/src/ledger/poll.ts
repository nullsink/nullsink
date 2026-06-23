// Pure classification of a settlement-poll tick's outcome for ONE rail — extracted from index.ts's pollRail
// so the alert/recovery state machine is unit-testable without a wallet, timers, or a logger. The poller still
// owns the per-rail consecutive-failure streak (pollFailsByRail), the actual I/O, and the logging; this just
// decides — given the prior streak and whether THIS tick's deposit fetch succeeded — the new streak count and
// which event occurred. Paging-critical: a streak that reaches the alert threshold is the "POLL BLIND" marker
// deploy/status-check.sh pages on.

export type PollOutcome = {
  fails: number; // the new consecutive-failure count to store for this rail
  event: "blind" | "transient" | "recovered" | null; // null = nothing to log; the poller maps the event to its log level
};

// On FAILURE: increment the streak; a streak reaching alertThreshold is a real outage ("blind", ERROR), below
// it a normal transient (WARN, retried next tick). On SUCCESS: clear the streak, announcing recovery ONCE
// (INFO) iff we'd crossed the threshold, else nothing. Behaviour-identical to the inline logic it replaced.
export function classifyPollOutcome(prevFails: number, succeeded: boolean, alertThreshold: number): PollOutcome {
  if (!succeeded) {
    const fails = prevFails + 1;
    return fails >= alertThreshold
      ? { fails, event: "blind" }
      : { fails, event: "transient" };
  }
  if (prevFails >= alertThreshold) return { fails: 0, event: "recovered" };
  return { fails: 0, event: null };
}
