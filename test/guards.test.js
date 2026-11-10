// -----------------------------------------------------------------------------
// Guards of review r1: the pause level across token renewals and restarts,
// one /data read at a time, OAuth races, redirects of the token endpoint,
// stop() after the spacing, rotation, pause end, slow Gladys status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { MemoryStore } from '../src/store.js';
import { ACCESS_TOKEN, NEW_REFRESH_TOKEN, startTokenServer } from './helpers/fakeGoogle.js';
import {
  NOW,
  REDIRECT,
  broadcast,
  fullConfig,
  settle,
  setup,
  sleep,
  statuses,
  until,
  within,
} from './helpers/app.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const authorize = async (gladys) => {
  const ack = await within(gladys.fake.oauthAuthorizeUrl('google_account', REDIRECT), 3000, 'url');
  assert.equal(ack.success, true, ack.error);
  return new URL(ack.data.authorize_url).searchParams.get('state');
};

// --- I1 ---------------------------------------------------------------------------

test('Assistant quota: the pause doubles across token renewals and a restart', async (t) => {
  const ctx = await setup(t, { assistant: 'quota' });
  await broadcast(ctx.gladys, { message: 'a' });
  assert.equal(ctx.store.data.pause.level, 0);
  await ctx.step(60_001);
  ctx.app.access = undefined; // the token expired: the next broadcast renews it
  await broadcast(ctx.gladys, { message: 'b' });
  assert.equal(ctx.token.count(), 2);
  assert.equal(ctx.store.data.pause.level, 1, 'a token renewal does not reset the level');
  assert.ok(Math.abs(ctx.store.data.pause.until - ctx.clock.now - 120_000) < 1000);
  await ctx.step(120_001);
  ctx.app.stop();
  // The new process starts its virtual clock at NOW again: the pause is dated as ended.
  ctx.store.data.pause.until = NOW - 1;
  // Restart on the same /data after the end of the pause: renewal at start, level kept.
  const again = await setup(t, { assistant: 'quota', store: ctx.store });
  assert.equal(again.token.count(), 1);
  assert.equal(ctx.store.data.pause.level, 1);
  await broadcast(again.gladys, { message: 'c' });
  assert.equal(ctx.store.data.pause.level, 2);
  // Only a success of the Assistant resets it.
  again.google.mode = 'ok';
  await again.step(240_001);
  assert.equal((await broadcast(again.gladys, { message: 'd' })).success, true);
  assert.equal(ctx.store.data.pause, null);
});

test('a pause of the token endpoint ends with its next success, the level kept', async (t) => {
  const ctx = await setup(t, { token: '503' });
  assert.equal(ctx.store.data.pause.source, 'token');
  ctx.token.mode = 'ok';
  await ctx.step(60_020); // the end of the pause renews the token
  await until(() => ctx.token.count() === 2);
  await settle();
  assert.equal(ctx.store.data.pause.level, 0);
  ctx.token.mode = '503';
  ctx.app.access = undefined;
  await broadcast(ctx.gladys, { message: 'a' });
  assert.equal(ctx.store.data.pause.level, 1);
});

// --- I2 ---------------------------------------------------------------------------

test('/data stuck: one read at a time over ten retries; broadcasts never wait on it', async (t) => {
  const store = new MemoryStore(undefined, { now: () => NOW });
  let unstick;
  store.stuckLoad = new Promise((resolve) => (unstick = resolve));
  t.after(() => unstick());
  const ctx = await setup(t, { store, start: false });
  ctx.gladys.connect();
  await until(() => store.loads === 1);
  await ctx.step(TIMINGS.storeTimeout);
  await until(() => statuses(ctx.gladys).at(-1)?.[0] === true);
  for (let i = 0; i < 10; i += 1) await ctx.step(TIMINGS.storeRetry);
  assert.equal(store.loads, 1);
  const ack = await broadcast(ctx.gladys, { message: 'a' });
  assert.equal(ack.success, true, ack.error);
  // Once the read ends, the next retry reads again.
  unstick();
  await settle();
  await ctx.step(TIMINGS.storeRetry);
  await until(() => store.loads === 2);
  await until(() => ctx.app.storeState === 'ok');
});

test('/data unreadable: one warning per change of state, not one per retry', async (t) => {
  const store = new MemoryStore(undefined, { state: 'unreadable', now: () => NOW });
  const ctx = await setup(t, { store });
  for (let i = 0; i < 5; i += 1) await ctx.step(TIMINGS.storeRetry);
  assert.equal(ctx.lines.filter((l) => l.includes('/data unreadable')).length, 1);
});

test('a pause set while /data is unreadable is written once it is readable', async (t) => {
  const store = new MemoryStore(undefined, { state: 'unreadable', now: () => NOW });
  const ctx = await setup(t, { store, assistant: 'quota' });
  await broadcast(ctx.gladys, { message: 'a' });
  assert.equal(store.saves, 0);
  store.state = 'ok';
  await ctx.step(TIMINGS.storeRetry);
  await until(() => store.saves >= 1);
  assert.equal(store.data.pause.level, 0);
  assert.equal(store.data.pause.source, 'assistant');
});

// --- I3: OAuth races and shapes ---------------------------------------------------

/** The token endpoint holding the refresh requests until `release`, answering codes at once. */
function holdRefresh(ctx, refreshAnswer) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  ctx.token.reply = async (req, form, res) => {
    if (form.grant_type === 'refresh_token') {
      await held;
      return refreshAnswer(res);
    }
    return json(res, 200, {
      access_token: 'ya29.from-connect',
      refresh_token: NEW_REFRESH_TOKEN,
      expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/assistant-sdk-prototype',
    });
  };
  return () => release();
}

test('an old renewal refused after Connect: never a refusal of the new account', async (t) => {
  const ctx = await setup(t);
  const release = holdRefresh(ctx, (res) => json(res, 400, { error: 'invalid_grant' }));
  ctx.app.access = undefined;
  const pending = ctx.gladys.fake.sceneAction('broadcast', { message: 'a' });
  await until(() => ctx.token.count('refresh_token') === 2);
  const state = await authorize(ctx.gladys);
  const ack = await within(
    ctx.gladys.fake.oauthCallback('google_account', { code: 'c', state, redirectUri: REDIRECT }),
    5000,
    'callback',
  );
  assert.equal(ack.success, true, ack.error);
  release();
  const old = await within(pending, 5000, 'old');
  assert.match(old.error, /^Nothing sent: /);
  assert.equal(ctx.app.refusal(), undefined);
  assert.equal(ctx.store.data.refused, null);
  assert.deepEqual(statuses(ctx.gladys).at(-1), [true, 'Google account linked.']);
});

test('an old renewal answered after Connect: the token of Connect stays', async (t) => {
  const ctx = await setup(t);
  ctx.google.accepted = ['ya29.from-connect'];
  const release = holdRefresh(ctx, (res) =>
    json(res, 200, { access_token: `${ACCESS_TOKEN}-old`, expires_in: 3599 }),
  );
  ctx.app.access = undefined;
  const pending = ctx.gladys.fake.sceneAction('broadcast', { message: 'a' });
  await until(() => ctx.token.count('refresh_token') === 2);
  const state = await authorize(ctx.gladys);
  await within(
    ctx.gladys.fake.oauthCallback('google_account', { code: 'c', state, redirectUri: REDIRECT }),
    5000,
    'callback',
  );
  release();
  await within(pending, 5000, 'old');
  await ctx.step(TIMINGS.minGap);
  const ack = await broadcast(ctx.gladys, { message: 'b' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.google.calls.at(-1).headers.authorization, 'Bearer ya29.from-connect');
});

test('the OAuth client changed during the authorization: refused, Google not asked', async (t) => {
  const ctx = await setup(t);
  const state = await authorize(ctx.gladys);
  await within(
    ctx.gladys.fake.configUpdated(fullConfig({ client_id: 'other.apps.googleusercontent.com' })),
    5000,
    'config',
  );
  const before = ctx.token.count();
  const ack = await within(
    ctx.gladys.fake.oauthCallback('google_account', { code: 'c', state, redirectUri: REDIRECT }),
    5000,
    'callback',
  );
  assert.match(ack.error, /OAuth client changed/);
  assert.equal(ctx.token.count('authorization_code'), 0);
  assert.equal(ctx.token.count(), before);
});

test('a code with CR/LF or too long: refused, Google not asked', async (t) => {
  const ctx = await setup(t);
  for (const code of ['4/a\r\nb', 'x'.repeat(2049), '', 42]) {
    const state = await authorize(ctx.gladys);
    const ack = await within(
      ctx.gladys.fake.oauthCallback('google_account', { code, state, redirectUri: REDIRECT }),
      5000,
      'callback',
    );
    assert.match(ack.error, /authorization code/);
  }
  assert.equal(ctx.token.count('authorization_code'), 0);
});

test('a redirect of the token endpoint is never followed (the form would go elsewhere)', async (t) => {
  const ctx = await setup(t, { start: false });
  const elsewhere = await startTokenServer();
  t.after(() => elsewhere.close());
  ctx.token.reply = (req, form, res) => {
    res.writeHead(307, { location: elsewhere.url });
    res.end();
  };
  await within(ctx.gladys.connect(), 5000, 'connect');
  await until(() => statuses(ctx.gladys).length > 0);
  await sleep(50);
  assert.equal(elsewhere.requests.length, 0);
  assert.equal(ctx.app.refusal(), undefined);
});

test('stop() during the spacing: no renewal, no request after it', async (t) => {
  const ctx = await setup(t);
  assert.equal((await broadcast(ctx.gladys, { message: 'a' })).success, true);
  ctx.app.access = undefined;
  const pending = ctx.gladys.fake.sceneAction('broadcast', { message: 'b' });
  await sleep(20);
  ctx.app.stop();
  await ctx.step(TIMINGS.minGap);
  const ack = await within(pending, 3000, 'ack');
  assert.equal(ack.error, 'Nothing sent: the integration is stopping.');
  assert.equal(ctx.token.count(), 1);
  assert.equal(ctx.google.calls.length, 1);
});

// --- minors --------------------------------------------------------------------------

test('a refresh token rotated during a broadcast: the broadcast goes out', async (t) => {
  const ctx = await setup(t);
  ctx.app.access = undefined;
  ctx.token.reply = (req, form, res) =>
    json(res, 200, {
      access_token: ACCESS_TOKEN,
      expires_in: 3599,
      refresh_token: NEW_REFRESH_TOKEN,
    });
  const ack = await broadcast(ctx.gladys, { message: 'a' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.gladys.fake.config.refresh_token, NEW_REFRESH_TOKEN);
});

test('a rotated refresh token of a bad shape is not saved', async (t) => {
  const ctx = await setup(t);
  ctx.app.access = undefined;
  ctx.token.reply = (req, form, res) =>
    json(res, 200, { access_token: ACCESS_TOKEN, expires_in: 3599, refresh_token: 'a\r\nb' });
  const ack = await broadcast(ctx.gladys, { message: 'a' });
  assert.equal(ack.success, true, ack.error);
  assert.notEqual(ctx.gladys.fake.config.refresh_token, 'a\r\nb');
});

test('the end of a pause republishes the status (no frozen countdown)', async (t) => {
  const ctx = await setup(t, { assistant: 'quota' });
  await broadcast(ctx.gladys, { message: 'a' });
  await until(() => /slow down/.test(statuses(ctx.gladys).at(-1)?.[1] ?? ''));
  await ctx.step(60_020);
  await until(() => statuses(ctx.gladys).at(-1)?.[0] === true);
});

test('a slow Gladys status never delays the next broadcast in the queue', async (t) => {
  const ctx = await setup(t, { assistant: 'denied' });
  ctx.gladys.setConnectionStatus = () => new Promise(() => {}); // never answers
  const first = ctx.gladys.fake.sceneAction('broadcast', { message: 'a' });
  const second = ctx.gladys.fake.sceneAction('broadcast', { message: 'b' });
  await until(() => ctx.google.calls.length === 1);
  ctx.google.mode = 'ok';
  for (let i = 0; i < 5 && ctx.google.calls.length < 2; i += 1) await ctx.step(TIMINGS.minGap);
  const [a, b] = await within(Promise.all([first, second]), 5000, 'acks');
  assert.equal(a.success, false);
  assert.equal(b.success, true, b.error);
});

test('a Connect that ends during a pause of the Assistant: the pause stays', async (t) => {
  const ctx = await setup(t);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  ctx.token.reply = async (req, form, res) => {
    await held;
    json(res, 200, {
      access_token: 'ya29.from-connect',
      refresh_token: NEW_REFRESH_TOKEN,
      expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/assistant-sdk-prototype',
    });
  };
  const state = await authorize(ctx.gladys);
  const pending = ctx.gladys.fake.oauthCallback('google_account', {
    code: 'c',
    state,
    redirectUri: REDIRECT,
  });
  await until(() => ctx.token.count('authorization_code') === 1);
  ctx.app.recordPause('assistant');
  release();
  await within(pending, 5000, 'callback');
  assert.ok(
    ctx.app.pausedFor(ctx.app.monotonic()) > 0,
    'the Assistant pause is not lifted by Connect',
  );
});
