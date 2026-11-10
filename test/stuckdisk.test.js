// -----------------------------------------------------------------------------
// A stuck /data on the real FileStore, in real time (sped up 20 times): the
// open of a FIFO without O_NONBLOCK blocks a libuv thread like a dead disk or
// NFS. Over many retries, one open only, and broadcasts still go out.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AssistantClient } from '../src/assistant.js';
import { AssistantApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { FileStore } from '../src/store.js';
import { fullConfig, memoryLogger, sleep, until, within } from './helpers/app.js';
import { TLS, startAssistantServer, startTokenServer } from './helpers/fakeGoogle.js';
import { realClock } from './helpers/realclock.js';

test('stuck /data (real FileStore, real clock): one open over the retries, broadcasts sent', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'gassist-stuck-'));
  const fifo = join(path, 'google-assistant.json');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    await rm(path, { recursive: true, force: true });
    t.skip('mkfifo not available');
    return;
  }
  const token = await startTokenServer();
  const google = await startAssistantServer();
  const clock = realClock({ speed: 20 });
  let opens = 0;
  const store = new FileStore({
    dir: path,
    now: clock.now,
    // Blocking open: what a dead disk does to the libuv thread.
    openFile: (file, flags) => {
      opens += 1;
      return open(file, flags & ~constants.O_NONBLOCK);
    },
  });
  const gladys = createFakeGladys({ selector: 'gassist', config: fullConfig() });
  const { logger } = memoryLogger();
  const app = new AssistantApp({
    gladys,
    logger,
    store,
    timers: clock.timers,
    now: clock.now,
    monotonic: clock.monotonic,
    client: new AssistantClient({ origin: google.origin, tls: TLS, timers: clock.timers }),
    tokenUrl: token.url,
  });
  const connection = registerHandlers(gladys, app, logger, clock.timers);
  t.after(async () => {
    connection.stop();
    app.stop();
    clock.close();
    // A writer wakes the blocked open before the directory goes.
    try {
      closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK));
    } catch {
      // gone already
    }
    await Promise.all([token.close(), google.close()]);
    await rm(path, { recursive: true, force: true });
  });
  await within(gladys.connect(), 5000, 'connect');
  await until(() => app.storeState === 'unreadable', 5000);
  // Ten retries of /data (10 s each, sped up).
  await sleep((10 * TIMINGS.storeRetry) / clock.speed + 200);
  assert.equal(opens, 1, 'a new open while the previous one is stuck');
  for (let i = 0; i < 6; i += 1) {
    const ack = await within(
      gladys.fake.sceneAction('broadcast', { message: `m${i}` }),
      8000,
      'ack',
    );
    assert.equal(ack.success, true, ack.error);
  }
  assert.equal(google.calls.length, 6);
});
