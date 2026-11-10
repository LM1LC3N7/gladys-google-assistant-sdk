// -----------------------------------------------------------------------------
// Real clock (sped up 50 times): the gap between two requests to the
// Assistant, measured on the queue of a scene that fires several broadcasts
// at once, never under TIMINGS.minGap.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AssistantClient } from '../src/assistant.js';
import { AssistantApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { fullConfig, memoryLogger, until, within } from './helpers/app.js';
import { TLS, startAssistantServer, startTokenServer } from './helpers/fakeGoogle.js';
import { measurePeriod, realClock, spyOn } from './helpers/realclock.js';

test('real clock: queued broadcasts go out at least 1 s apart', async (t) => {
  const token = await startTokenServer();
  const google = await startAssistantServer();
  const clock = realClock({ speed: 50 });
  const gladys = createFakeGladys({ selector: 'gassist', config: fullConfig() });
  const { logger } = memoryLogger();
  const client = new AssistantClient({ origin: google.origin, tls: TLS, timers: clock.timers });
  const app = new AssistantApp({
    gladys,
    logger,
    store: new MemoryStore(),
    timers: clock.timers,
    now: clock.now,
    monotonic: clock.monotonic,
    client,
    tokenUrl: token.url,
  });
  const connection = registerHandlers(gladys, app, logger, clock.timers);
  t.after(async () => {
    connection.stop();
    app.stop();
    clock.close();
    await Promise.all([token.close(), google.close()]);
  });
  await within(gladys.connect(), 5000, 'connect');
  await until(() => app.config && !app.refreshing && gladys.fake.connectionStatus?.connected);
  // The method that decides (takeSlot), not the request: its latency blurs the gap.
  const spy = spyOn(app, 'takeSlot', clock);
  const acks = [1, 2, 3, 4].map((i) => gladys.fake.sceneAction('broadcast', { message: `m${i}` }));
  // Late under load, never early: min = the gap, max wide for a loaded CI.
  const gaps = await measurePeriod(spy, {
    count: 4,
    min: TIMINGS.minGap,
    max: TIMINGS.minGap * 4,
    timeoutMs: 8000,
  });
  assert.equal(gaps.length, 3);
  const results = await within(Promise.all(acks), 8000, 'acks');
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, true],
  );
  app.stop();
  connection.stop();
});
