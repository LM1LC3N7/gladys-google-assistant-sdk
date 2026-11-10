// -----------------------------------------------------------------------------
// FileStore on a real temporary directory: round trip, empty vs unreadable,
// bounded reads (a FIFO is never waited on), the latest write wins.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, emptyData } from '../src/store.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'gassist-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const NOW = 1_800_000_000_000;

test('missing file: empty; written then read back', async (t) => {
  const store = new FileStore({ dir: await dir(t), now: () => NOW });
  assert.equal((await store.load()).state, 'empty');
  const data = { ...emptyData(), refused: { fp: '0f', kind: 'grant', at: NOW - 1 } };
  assert.equal(await store.save(data), true);
  const back = await store.load();
  assert.equal(back.state, 'ok');
  assert.deepEqual(back.data, data);
});

test('invalid JSON, too large, a directory: unreadable, never empty', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path, now: () => NOW });
  await writeFile(store.path, '{not json');
  assert.equal((await store.load()).state, 'unreadable');
  await writeFile(store.path, `{"salt":"${'a'.repeat(32 * 1024)}"}`);
  assert.equal((await store.load()).state, 'unreadable');
  const other = new FileStore({ dir: path, name: '.', now: () => NOW });
  assert.equal((await other.load()).state, 'unreadable');
});

test('a FIFO in place of the file: refused at once, never waited on', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path, now: () => NOW });
  try {
    execFileSync('mkfifo', [store.path]);
  } catch {
    t.skip('mkfifo not available');
    return;
  }
  const started = Date.now();
  assert.equal((await store.load()).state, 'unreadable');
  assert.ok(Date.now() - started < 1500);
});

test('writes one at a time, the latest one wins', async (t) => {
  const store = new FileStore({ dir: await dir(t), now: () => NOW });
  const writes = [1, 2, 3].map((level) =>
    store.save({ ...emptyData(), pause: { until: NOW + 1000, level } }),
  );
  assert.deepEqual(await Promise.all(writes), [true, true, true]);
  const text = await readFile(store.path, 'utf8');
  assert.equal(JSON.parse(text).pause.level, 3);
});

test('a directory that cannot be created: save says false', async (t) => {
  const path = await dir(t);
  await writeFile(join(path, 'file'), 'x');
  const store = new FileStore({ dir: join(path, 'file', 'sub'), now: () => NOW });
  assert.equal(await store.save(emptyData()), false);
});
