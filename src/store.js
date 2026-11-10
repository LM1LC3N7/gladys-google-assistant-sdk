// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data/google-assistant.json
// (the one writable volume):
// - `refused`: Google refused the refresh token or the OAuth client, as an
//   8-bit salted fingerprint of (client ID, client secret, refresh token) —
//   never a token, never a fingerprint of credentials that work — so a
//   restart never asks Google again with what it refused. Removed at the
//   first success; a new token from Connect always lifts it, changed client
//   credentials have 255 chances in 256 to look new;
// - `pause`: the end of a pause asked by Google (429 or 5xx), on the wall
//   clock, with its level (the pause doubles each time; only a success of
//   the Assistant resets it) and its source (token endpoint or Assistant).
// The tokens themselves live in the Gladys configuration (off-schema keys),
// never here.
//
// Bounded: the file is read within TIMINGS.storeTimeout, at most
// LIMITS.storeBytes, and must be a regular file (a FIFO or a device is
// refused, never waited on). An unreadable file is not an empty one: it is
// never overwritten. Writes go one at a time, the latest data wins.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, TIMINGS } from './constants.js';

export const newSalt = () => randomBytes(16).toString('hex');
export const emptyData = () => ({ salt: newSalt(), refused: null, pause: null });

const HEX_DIGITS = Math.ceil(LIMITS.refusedBits / 4);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The fingerprint of the credentials, truncated: says "maybe the same", never the token. */
export function fingerprint(salt, { clientId, clientSecret, refreshToken }) {
  return createHmac('sha256', salt)
    .update(`${clientId}\n${clientSecret}\n${refreshToken}`)
    .digest('hex')
    .slice(0, HEX_DIGITS);
}

/** What a file holds, checked: unknown keys dropped, impossible dates refused. */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data)) return base;
  if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)) base.salt = data.salt;
  const refused = data.refused;
  if (
    isObject(refused) &&
    typeof refused.fp === 'string' &&
    new RegExp(`^[0-9a-f]{${HEX_DIGITS}}$`).test(refused.fp) &&
    (refused.kind === 'grant' || refused.kind === 'client')
  ) {
    const at = Number.isFinite(refused.at) && refused.at <= now ? refused.at : now;
    base.refused = { fp: refused.fp, kind: refused.kind, at };
  }
  const pause = data.pause;
  if (isObject(pause) && Number.isFinite(pause.until) && Number.isInteger(pause.level)) {
    const source = pause.source === 'token' ? 'token' : 'assistant';
    // A pause ending beyond its own maximum from now is a wrong date: dropped.
    if (pause.until > now && pause.until - now <= TIMINGS.pauseMax) {
      base.pause = { until: pause.until, level: Math.min(Math.max(pause.level, 0), 20), source };
    } else if (pause.until <= now && pause.until > now - TIMINGS.pauseMax) {
      // Ended: the level is kept so a new error still doubles it.
      base.pause = { until: pause.until, level: Math.min(Math.max(pause.level, 0), 20), source };
    }
  }
  return base;
}

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

export class FileStore {
  constructor({
    dir = process.env.DATA_DIR || '/data',
    name = 'google-assistant.json',
    now = Date.now,
    openFile = open,
  } = {}) {
    this.openFile = openFile;
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
    this.chain = Promise.resolve();
    this.pending = undefined;
  }

  /** -> { data, state: 'ok' | 'empty' | 'unreadable' } within the bound. */
  async load() {
    let handle;
    const read = async () => {
      // O_NONBLOCK: opening a FIFO never waits for a writer.
      handle = await this.openFile(
        this.path,
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a regular file');
      if (stat.size > LIMITS.storeBytes) throw new Error('too large');
      const buffer = Buffer.alloc(LIMITS.storeBytes + 1);
      let bytesRead = 0;
      for (;;) {
        let n;
        try {
          ({ bytesRead: n } = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            null,
          ));
        } catch (err) {
          if (err?.code === 'EAGAIN') break;
          throw err;
        }
        if (n === 0) break;
        bytesRead += n;
        if (bytesRead >= buffer.length) break;
      }
      if (bytesRead > LIMITS.storeBytes) throw new Error('too large');
      return buffer.subarray(0, bytesRead).toString('utf8');
    };
    try {
      const text = await withTimeout(read(), TIMINGS.storeTimeout);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { data: emptyData(), state: 'unreadable' };
      }
      return { data: sanitize(json, this.now()), state: 'ok' };
    } catch (err) {
      if (err?.code === 'ENOENT') return { data: emptyData(), state: 'empty' };
      return { data: emptyData(), state: 'unreadable' };
    } finally {
      handle?.close().catch(() => {});
    }
  }

  /**
   * Writes `data` (a copy is taken now). Resolves true when written, false
   * otherwise; one write at a time, a later call replaces a waiting one.
   */
  save(data) {
    const text = JSON.stringify(data);
    const waiting = this.pending;
    this.pending = { text, resolvers: [] };
    const job = this.pending;
    if (waiting) job.resolvers.push(...waiting.resolvers);
    const result = new Promise((resolve) => job.resolvers.push(resolve));
    if (!waiting) {
      this.chain = this.chain.then(async () => {
        const current = this.pending;
        this.pending = undefined;
        let ok;
        try {
          await mkdir(this.dir, { recursive: true });
          const temporary = `${this.path}.${process.pid}.tmp`;
          await writeFile(temporary, current.text, { mode: 0o600 });
          await rename(temporary, this.path);
          ok = true;
        } catch {
          ok = false;
        }
        for (const resolve of current.resolvers) resolve(ok);
      });
    }
    return result;
  }
}

/** For the tests: in memory, with failures and delays on demand. */
export class MemoryStore {
  constructor(data = emptyData(), { state = 'ok', now = Date.now } = {}) {
    this.data = structuredClone(data);
    this.state = state;
    this.saves = 0;
    this.loads = 0;
    this.now = now;
    this.failing = false;
    /** A promise the next loads wait for (a stuck disk). */
    this.stuckLoad = undefined;
  }

  async load() {
    this.loads += 1;
    if (this.stuckLoad) await this.stuckLoad;
    if (this.state === 'unreadable') return { data: emptyData(), state: 'unreadable' };
    return { data: sanitize(structuredClone(this.data), this.now()), state: this.state };
  }

  async save(data) {
    if (this.failing) return false;
    this.data = structuredClone(data);
    this.state = 'ok';
    this.saves += 1;
    return true;
  }
}
