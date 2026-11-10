// -----------------------------------------------------------------------------
// AssistantApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a fake Google on real loopback sockets, a memory store
// and a virtual clock: the timers only fire when the test advances the clock,
// and the monotonic clock moves 1 µs at each read (a decision that reads it
// twice is caught). Every wait is bounded: a test fails, never hangs.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AssistantClient } from '../../src/assistant.js';
import { AssistantApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { MemoryStore } from '../../src/store.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
  TLS,
  startAssistantServer,
  startTokenServer,
} from './fakeGoogle.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'google-assistant-sdk';
export const NOW = 1_800_000_000_000;
export const REDIRECT = 'https://my.gladysassistant.com/redirect/oauth';

/** Waits (real time, bounded) until `condition()` holds; the I/O is real. */
export async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms: ${condition}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that rejects after `ms` (real time): no test waits without end. */
export function within(promise, ms = 5000, what = 'promise') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} not settled in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A logger that keeps every line, arguments included. */
export function memoryLogger() {
  const lines = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) =>
        lines.push(
          `${level} ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`,
        ),
    ]),
  );
  return { logger, lines };
}

export const fullConfig = (extra = {}) => ({
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  language: 'fr-FR',
  refresh_token: REFRESH_TOKEN,
  ...extra,
});

export async function setup(
  t,
  { config, store, start = true, token: tokenMode, assistant: assistantMode } = {},
) {
  const token = await startTokenServer();
  const google = await startAssistantServer();
  t.after(() => Promise.all([token.close(), google.close()]));
  if (tokenMode) token.mode = tokenMode;
  if (assistantMode) google.mode = assistantMode;
  const gladys = createFakeGladys({ selector: SELECTOR, config: config ?? fullConfig() });
  const { clock, timers, advance, pending } = createFakeClock(NOW);
  let drift = 0;
  const { logger, lines } = memoryLogger();
  const kept = store ?? new MemoryStore(undefined, { now: () => clock.now });
  const app = new AssistantApp({
    gladys,
    logger,
    store: kept,
    timers,
    now: () => clock.now,
    monotonic: () => clock.now + (drift += 0.001),
    client: new AssistantClient({ origin: google.origin, tls: TLS, timers }),
    tokenUrl: token.url,
  });
  const connection = registerHandlers(gladys, app, logger, timers);
  t.after(() => {
    connection.stop();
    app.stop();
  });
  if (start) {
    await within(gladys.connect(), 5000, 'connect');
    await until(() => app.config && app.storeState !== undefined && !app.refreshing);
    await settle();
  }
  /** Runs the due timers, then waits (real time) for the I/O they started. */
  const step = async (ms = 0) => {
    await advance(ms);
    await sleep(5);
  };
  return {
    gladys,
    app,
    token,
    google,
    lines,
    store: kept,
    clock,
    advance,
    pending,
    step,
    connection,
  };
}

/** Lets the pending promises and I/O run a little. */
export async function settle(ms = 20) {
  await sleep(ms);
}

/** The statuses Gladys received, oldest first. */
export const statuses = (gladys) =>
  gladys.fake.connectionStatuses.map((b) => [b.connected, b.message?.en]);

/** The scene action through the fake Gladys: the ack. */
export function broadcast(gladys, fields) {
  return within(gladys.fake.sceneAction('broadcast', fields), 8000, 'scene ack');
}

/** Runs a scene action while the virtual clock moves, until it acks. */
export async function broadcastWhileAdvancing(ctx, fields, { every = 500, max = 60_000 } = {}) {
  let settled = false;
  const ack = ctx.gladys.fake.sceneAction('broadcast', fields).finally(() => (settled = true));
  for (let spent = 0; spent <= max && !settled; spent += every) {
    await ctx.step(every);
  }
  return within(ack, 5000, 'scene ack');
}
