// -----------------------------------------------------------------------------
// FileStore on a real temporary directory: round trip, empty vs unreadable,
// bounded reads (a FIFO is never waited on), the latest write wins.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  // Under a mutant that opens the FIFO blocking, a writer wakes the open up
  // (before the directory is removed): the test fails, the process never hangs.
  const wake = () => {
    try {
      closeSync(openSync(store.path, constants.O_RDWR | constants.O_NONBLOCK));
    } catch {
      // gone already
    }
  };
  try {
    const started = Date.now();
    assert.equal((await store.load()).state, 'unreadable');
    assert.ok(Date.now() - started < 1500);
  } finally {
    wake();
  }
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

test('a symbolic link in place of the file: unreadable, never followed', async (t) => {
  const path = await dir(t);
  const target = join(path, 'elsewhere.json');
  await writeFile(target, JSON.stringify(emptyData()));
  const store = new FileStore({ dir: path, now: () => NOW });
  await symlink(target, store.path);
  assert.equal((await store.load()).state, 'unreadable');
});

test('a disk that never answers: one open only, however many loads', async (t) => {
  const path = await dir(t);
  let opens = 0;
  const store = new FileStore({
    dir: path,
    now: () => NOW,
    openFile: () => {
      opens += 1;
      return new Promise(() => {}); // stuck in the kernel
    },
  });
  const started = Date.now();
  for (let i = 0; i < 10; i += 1) assert.equal((await store.load()).state, 'unreadable');
  assert.equal(opens, 1);
  assert.ok(Date.now() - started < 4000, 'only the first load waits for its bound');
});

test('a read that ends late frees the next one, and its handle is closed', async (t) => {
  const path = await dir(t);
  let release;
  let closed = 0;
  let opens = 0;
  const store = new FileStore({
    dir: path,
    now: () => NOW,
    openFile: async () => {
      opens += 1;
      if (opens === 1) await new Promise((resolve) => (release = resolve));
      return {
        stat: async () => ({ isFile: () => true, size: 2 }),
        read: async () => ({ bytesRead: 0 }),
        close: async () => {
          closed += 1;
        },
      };
    },
  });
  assert.equal((await store.load()).state, 'unreadable');
  assert.equal((await store.load()).state, 'unreadable');
  assert.equal(opens, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, 1);
  await store.load();
  assert.equal(opens, 2);
});
