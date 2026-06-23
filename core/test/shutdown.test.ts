// Tests for the graceful-shutdown drain (src/shutdown.ts). The clock, poll-sleep, and "handlers returned"
// signal are injected, so the wait loop is exercised deterministically — no real time, no real server.
import { test, expect } from "bun:test";
import { drainInflight } from "../src/shutdown";

// A fake sleep that advances an injected clock by the poll interval, so `now()` reaches the deadline
// without any real waiting. Optionally runs a side effect each tick (to simulate work finishing).
const fakeClock = (onTick?: (t: number) => void) => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      onTick?.(t);
    },
    t: () => t,
  };
};

test("force-settles every stream still live at the grace deadline, exactly once", async () => {
  const clock = fakeClock(); // streams never finish on their own → both hit the deadline
  const settled: string[] = [];
  const inflight = new Set<() => void>();
  const add = (id: string) => {
    const s = () => {
      settled.push(id);
      inflight.delete(s); // settle() removes itself, mutating the set mid-drain — the snapshot must survive this
    };
    inflight.add(s);
  };
  add("a");
  add("b");

  const res = await drainInflight({ inflight, handlersReturned: Promise.resolve(), graceMs: 1000, now: clock.now, sleep: clock.sleep });

  expect(res.forceSettled).toBe(2);
  expect(settled.sort()).toEqual(["a", "b"]); // each settled once (a double-settle would dup the id)
  expect(inflight.size).toBe(0);
  expect(clock.t()).toBeGreaterThanOrEqual(1000); // it waited the full grace before giving up
});

test("does NOT force-settle when in-flight streams finish naturally before the deadline", async () => {
  const inflight = new Set<() => void>();
  const s = () => inflight.delete(s);
  inflight.add(s);
  // The stream finishes on its own once the (simulated) clock passes 200ms — well inside the grace.
  const clock = fakeClock((t) => {
    if (t >= 200) inflight.delete(s);
  });

  const res = await drainInflight({ inflight, handlersReturned: Promise.resolve(), graceMs: 5000, now: clock.now, sleep: clock.sleep });

  expect(res.forceSettled).toBe(0); // drained on its own; nothing force-settled
  expect(inflight.size).toBe(0);
  expect(clock.t()).toBeLessThan(5000); // returned early, didn't burn the whole grace
});

test("waits for buffered handlers to return before exiting, even with no live streams", async () => {
  let resolveHandlers!: () => void;
  const handlersReturned = new Promise<void>((r) => {
    resolveHandlers = r;
  });
  // Buffered handlers "return" only after the clock passes 300ms; no streams are tracked in `inflight`.
  const clock = fakeClock((t) => {
    if (t >= 300) resolveHandlers();
  });

  const res = await drainInflight({ inflight: new Set(), handlersReturned, graceMs: 5000, now: clock.now, sleep: clock.sleep });

  expect(res.forceSettled).toBe(0);
  expect(clock.t()).toBeGreaterThanOrEqual(300); // kept polling until the buffered handlers drained
  expect(clock.t()).toBeLessThan(5000); // but still returned before the deadline
});

test("returns immediately-ish with nothing force-settled when nothing is in flight", async () => {
  const clock = fakeClock();
  const res = await drainInflight({ inflight: new Set(), handlersReturned: Promise.resolve(), graceMs: 1000, now: clock.now, sleep: clock.sleep });
  expect(res.forceSettled).toBe(0);
  expect(clock.t()).toBeLessThan(1000); // didn't wait the grace — there was nothing to wait for
});

test("a throwing settle() does not strand its siblings — they still settle, the throw is reported", async () => {
  const clock = fakeClock(); // none finish naturally → all hit the deadline
  const settled: string[] = [];
  const errors: unknown[] = [];
  const inflight = new Set<() => void>();
  const good = (id: string) => {
    const s = () => {
      settled.push(id);
      inflight.delete(s);
    };
    inflight.add(s);
  };
  const bad = () => {
    const s = () => {
      inflight.delete(s);
      throw new Error("settle boom");
    };
    inflight.add(s);
  };
  good("a");
  bad(); // the throwing straggler sits between two good ones
  good("b");

  const res = await drainInflight({ inflight, handlersReturned: Promise.resolve(), graceMs: 1000, now: clock.now, sleep: clock.sleep, onSettleError: (e) => errors.push(e) });

  expect(settled.sort()).toEqual(["a", "b"]); // both good ones settled despite the bad one throwing
  expect(errors).toHaveLength(1); // the throw was caught and surfaced, not swallowed silently or rethrown
  expect(res.forceSettled).toBe(2); // count reflects successful settles only
  expect(inflight.size).toBe(0);
});

test("graceMs=0 force-settles immediately with no natural-completion window", async () => {
  const clock = fakeClock();
  const settled: string[] = [];
  const inflight = new Set<() => void>();
  const s = () => {
    settled.push("x");
    inflight.delete(s);
  };
  inflight.add(s);

  const res = await drainInflight({ inflight, handlersReturned: Promise.resolve(), graceMs: 0, now: clock.now, sleep: clock.sleep });

  expect(res.forceSettled).toBe(1);
  expect(settled).toEqual(["x"]);
  expect(clock.t()).toBe(0); // deadline == now from the start → no wait, straight to force-settle
});

test("a rejected handlersReturned still drains a live stream (no unhandled rejection, force-settled at deadline)", async () => {
  const clock = fakeClock();
  const settled: string[] = [];
  const inflight = new Set<() => void>();
  const s = () => {
    settled.push("x");
    inflight.delete(s);
  };
  inflight.add(s);

  const res = await drainInflight({ inflight, handlersReturned: Promise.reject(new Error("server.stop failed")), graceMs: 500, now: clock.now, sleep: clock.sleep });

  expect(res.forceSettled).toBe(1); // the rejection sets handlersDone via the reject branch; the live stream still drains
  expect(settled).toEqual(["x"]);
});

test("force-settle iterates a SNAPSHOT, so a settle() that removes ANOTHER straggler can't skip it", async () => {
  // Guards the [...inflight] copy: drainInflight must visit every straggler that was live at the deadline
  // even if one settle() removes a not-yet-visited sibling mid-drain (a cascading/paired-stream settle).
  // Iterating the live Set instead would skip the removed sibling; the snapshot must not.
  const clock = fakeClock();
  const visited: string[] = [];
  const inflight = new Set<() => void>();
  let sb: () => void;
  const sa = () => {
    visited.push("a");
    inflight.delete(sa);
    inflight.delete(sb); // also removes b BEFORE the loop would reach it
  };
  sb = () => {
    visited.push("b");
    inflight.delete(sb);
  };
  inflight.add(sa);
  inflight.add(sb);

  const res = await drainInflight({ inflight, handlersReturned: Promise.resolve(), graceMs: 0, now: clock.now, sleep: clock.sleep });

  expect(res.forceSettled).toBe(2); // both settled from the snapshot (live-set iteration would skip b → 1)
  expect(visited.sort()).toEqual(["a", "b"]);
});
