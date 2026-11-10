// Real clock sped up, a spy and a period measure: from gladys-testkit (src/clock.mjs, Apache-2.0),
// copied so the tests run on GitHub without the kit.

import { AssertionError } from 'node:assert';

/** The real clock sped up `speed` times (timers shortened, clocks in simulated ms). */
export function realClock({ speed = 1 } = {}) {
  const p0 = performance.now();
  const w0 = Date.now();
  const live = new Set();
  const wrap =
    (set, clear, repeat) =>
    (fn, ms, ...args) => {
      clock.timersSet += 1;
      const h = set(
        () => {
          if (!repeat) live.delete(h);
          fn(...args);
        },
        Math.max(0, Number(ms) || 0) / speed,
      );
      live.add(h);
      return h;
    };
  const clear = (h) => {
    live.delete(h);
    clearTimeout(h);
  };
  const clock = {
    speed,
    timersSet: 0,
    now: () => w0 + (performance.now() - p0) * speed,
    monotonic: () => performance.now() * speed,
    timers: {
      setTimeout: wrap(setTimeout, clearTimeout, false),
      setInterval: wrap(setInterval, clearInterval, true),
      clearTimeout: clear,
      clearInterval: clear,
    },
    /** Waits `ms` simulated ms (real ms divided by speed). */
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / speed)),
    close() {
      for (const h of live) clearTimeout(h);
      live.clear();
    },
  };
  return clock;
}

/** Records the date (monotonic, simulated ms) of every call of object[method]. */
export function spyOn(object, method, clock) {
  const original = object[method];
  const spy = {
    clock,
    calls: [],
    restore: () => {
      object[method] = original;
    },
  };
  object[method] = function spied(...args) {
    spy.calls.push({ at: clock.monotonic(), args });
    return original.apply(this, args);
  };
  return spy;
}

/** Waits for `count` calls, then checks every gap is within min..max (simulated ms). */
export async function measurePeriod(
  spy,
  { count = 3, period, min = period * 0.9, max = period * 1.5, timeoutMs } = {},
) {
  if (!(min >= 0) || !(max >= min))
    throw new TypeError('measurePeriod: give period, or min and max');
  const speed = spy.clock?.speed ?? 1;
  const deadline = performance.now() + (timeoutMs ?? ((count + 1) * max) / speed + 2000);
  while (spy.calls.length < count && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const at = spy.calls.slice(0, count).map((c) => c.at);
  const gaps = at.slice(1).map((v, i) => Math.round(v - at[i]));
  const bad = gaps.filter((g) => g < min || g > max);
  if (at.length < count || bad.length > 0) {
    throw new AssertionError({
      message: `period: ${at.length}/${count} calls, gaps ${gaps.join(', ')} ms, expected ${Math.round(min)}..${Math.round(max)}`,
      actual: gaps,
      expected: { min, max },
      operator: 'measurePeriod',
    });
  }
  return gaps;
}
