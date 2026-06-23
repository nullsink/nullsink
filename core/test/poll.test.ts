// Unit tests for the pure poll-outcome classifier (src/poll.ts), extracted from index.ts's pollRail so the
// alert/recovery state machine is testable without a wallet, timers, or a logger. Pins the paging-critical
// "POLL BLIND" threshold + the announce-recovery-once semantics (the silent-blindness alert path, PRs #65/#67).
import { test, expect } from "bun:test";
import { classifyPollOutcome } from "../src/ledger/poll";

const ALERT = 5;

test("a transient failure increments the streak and stays WARN below the threshold", () => {
  expect(classifyPollOutcome(0, false, ALERT)).toEqual({ fails: 1, event: "transient" });
  expect(classifyPollOutcome(3, false, ALERT)).toEqual({ fails: 4, event: "transient" });
});

test("the streak reaching the threshold escalates to POLL BLIND (ERROR) and stays blind on every further miss", () => {
  expect(classifyPollOutcome(4, false, ALERT)).toEqual({ fails: 5, event: "blind" });
  expect(classifyPollOutcome(5, false, ALERT)).toEqual({ fails: 6, event: "blind" });
});

test("success clears the streak; recovery is announced ONCE, only if we had crossed the threshold", () => {
  expect(classifyPollOutcome(6, true, ALERT)).toEqual({ fails: 0, event: "recovered" }); // was blind → recovered
  expect(classifyPollOutcome(3, true, ALERT)).toEqual({ fails: 0, event: null }); // sub-threshold streak → silent clear
  expect(classifyPollOutcome(0, true, ALERT)).toEqual({ fails: 0, event: null }); // steady state → nothing
});
