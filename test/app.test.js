// -----------------------------------------------------------------------------
// The integration end to end: fake Gladys (the SDK's), the exact handlers, a
// fake Google (token endpoint + Assistant API) on loopback, virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { MemoryStore, emptyData, fingerprint } from '../src/store.js';
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  NEW_REFRESH_TOKEN,
  REFRESH_TOKEN,
  SECRETS,
} from './helpers/fakeGoogle.js';
import {
  NOW,
  broadcast,
  broadcastWhileAdvancing,
  fullConfig,
  settle,
  setup,
  sleep,
  statuses,
  until,
  within,
} from './helpers/app.js';

const lastStatus = (gladys) => statuses(gladys).at(-1);

function noSecret(ctx, extra = []) {
  const texts = [
    ...ctx.lines,
    JSON.stringify(ctx.store.data),
    JSON.stringify(statuses(ctx.gladys)),
    ...extra.map((x) => JSON.stringify(x)),
  ];
  for (const secret of SECRETS) {
    for (const text of texts) assert.ok(!text.includes(secret), `secret in ${text.slice(0, 120)}`);
  }
}

// --- startup -------------------------------------------------------------------

test('start: one token renewal, then "linked"', async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.token.count('refresh_token'), 1);
  const [{ form, headers }] = ctx.token.requests;
  assert.deepEqual(form, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  assert.match(
    headers['user-agent'],
    /^gladys-google-assistant-sdk\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\//,
  );
  assert.deepEqual(lastStatus(ctx.gladys), [true, 'Google account linked.']);
  assert.equal(ctx.google.calls.length, 0, 'no request to the Assistant at start');
  noSecret(ctx);
});

test('start without client, language or account: the status says what is missing, nothing asked', async (t) => {
  for (const [config, expected] of [
    [fullConfig({ client_id: '' }), /client ID and the client secret/],
    [fullConfig({ client_secret: undefined }), /client ID and the client secret/],
    [fullConfig({ client_secret: 'a\r\nb' }), /client ID and the client secret/],
    [fullConfig({ language: 'xx-XX' }), /language/],
    [fullConfig({ refresh_token: undefined }), /Click Connect/],
  ]) {
    const ctx = await setup(t, { config });
    assert.equal(ctx.token.requests.length, 0);
    const [connected, message] = lastStatus(ctx.gladys);
    assert.equal(connected, false);
    assert.match(message, expected);
    const ack = await broadcast(ctx.gladys, { message: 'hello' });
    assert.equal(ack.success, false);
    assert.match(ack.error, /^Nothing sent: /);
    assert.equal(ctx.google.calls.length, 0);
  }
});

test('a reconnection to Gladys keeps the access token: no second renewal', async (t) => {
  const ctx = await setup(t);
  await ctx.gladys.fake.send('connected');
  await within(ctx.connection.connected(), 3000, 'connected');
  await settle();
  assert.equal(ctx.token.count('refresh_token'), 1);
  // The status is published again at each connection.
  assert.equal(statuses(ctx.gladys).filter(([c]) => c).length >= 2, true);
});

test('getConfig() failing in `connected`: retried 5 s later with a status, then started', async (t) => {
  const ctx = await setup(t, { start: false });
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  let failures = 1;
  ctx.gladys.getConfig = async () => {
    // Only the call of the integration's `connected` handler fails (the SDK
    // reads the configuration itself while connecting).
    if (failures > 0 && new Error().stack.includes('handlers.js')) {
      failures -= 1;
      throw new Error('host API down');
    }
    return original();
  };
  await within(ctx.gladys.connect(), 5000, 'connect');
  await until(() => statuses(ctx.gladys).length === 1);
  assert.deepEqual(lastStatus(ctx.gladys), [
    false,
    'The configuration cannot be read from Gladys; new try in 5 s.',
  ]);
  await ctx.step(4999);
  assert.equal(ctx.app.config, undefined);
  await ctx.step(1);
  await until(() => ctx.app.config && lastStatus(ctx.gladys)[0] === true);
  assert.equal(ctx.token.count('refresh_token'), 1);
});

// --- broadcast -------------------------------------------------------------------

test('broadcast: the French command, accepted, no secret anywhere', async (t) => {
  const ctx = await setup(t);
  const ack = await broadcast(ctx.gladys, { message: 'Le dîner est prêt' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.google.texts(), ['Diffuse Le dîner est prêt']);
  assert.equal(ctx.google.calls[0].request.language, 'fr-FR');
  assert.equal(ctx.google.calls[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(ctx.token.count('refresh_token'), 1, 'the token of the start is reused');
  noSecret(ctx, [ack]);
});

test('broadcast to a room, in each language family', async (t) => {
  const cases = [
    ['fr-FR', 'Diffuse dans Cuisine À table'],
    ['en-GB', 'broadcast to Cuisine À table'],
    ['de-DE', 'Nachricht an alle an Cuisine À table'],
    ['pt-BR', 'Transmitir À table para Cuisine'],
    ['ja-JP', 'À tableとCuisineにブロードキャストして'],
  ];
  for (const [language, expected] of cases) {
    const ctx = await setup(t, { config: fullConfig({ language }) });
    const ack = await broadcast(ctx.gladys, { message: 'À table', room: 'Cuisine' });
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(ctx.google.texts(), [expected]);
  }
});

test('the message is put on one line; $ and {1} are plain text', async (t) => {
  const ctx = await setup(t);
  const ack = await broadcast(ctx.gladys, { message: ' Line 1\r\nline\t2 $& {1} $1 ' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.google.texts(), ['Diffuse Line 1 line 2 $& {1} $1']);
});

test('invalid messages and rooms: nothing sent, the input never echoed', async (t) => {
  const ctx = await setup(t);
  const long = `secret-${'x'.repeat(600)}`;
  for (const [fields, reason] of [
    [{ message: '' }, /message is empty/],
    [{ message: ' \n\t ' }, /message is empty/],
    [{}, /message is empty/],
    [{ message: long }, /longer than 500/],
    [{ message: { a: 1 } }, /not text/],
    [{ message: 'ok', room: 'r'.repeat(61) }, /room name/],
    [{ message: 'ok', room: ['x'] }, /not text/],
  ]) {
    const ack = await broadcast(ctx.gladys, fields);
    assert.equal(ack.success, false);
    assert.match(ack.error, /^Nothing sent: /);
    assert.match(ack.error, reason);
    assert.ok(!ack.error.includes('secret-'));
  }
  assert.equal(ctx.google.calls.length, 0);
  // 500 characters exactly is accepted (characters, not bytes).
  const ack = await broadcast(ctx.gladys, { message: 'é'.repeat(500) });
  assert.equal(ack.success, true, ack.error);
});

test('UNAUTHENTICATED on the cached token: renewed once, sent again, accepted', async (t) => {
  const ctx = await setup(t);
  ctx.google.accepted = [`${ACCESS_TOKEN}-2`];
  const ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.token.count('refresh_token'), 2);
  assert.equal(ctx.google.calls.length, 2);
  assert.equal(ctx.google.calls[1].headers.authorization, `Bearer ${ACCESS_TOKEN}-2`);
});

test('UNAUTHENTICATED on a fresh token: reported, never a refusal of the refresh token', async (t) => {
  const ctx = await setup(t);
  ctx.google.accepted = ['nothing'];
  const ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /^Nothing sent: Google Assistant did not accept a fresh access token/);
  assert.equal(ctx.google.calls.length, 2, 'one renewal, one retry, no loop');
  assert.equal(ctx.store.data.refused, null);
  assert.equal(ctx.app.refusal(), undefined);
  assert.match(lastStatus(ctx.gladys)[1], /did not accept a fresh access token/);
  // The next broadcast tries again (renewal + request).
  ctx.google.accepted = [ACCESS_TOKEN];
  await ctx.step(TIMINGS.minGap);
  const again = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(again.success, true, again.error);
  assert.deepEqual(lastStatus(ctx.gladys), [true, 'Google account linked.']);
});

// --- refusals ----------------------------------------------------------------------

test('invalid_grant: refusal kept in /data (8 bits), never asked again, lifted by a new token', async (t) => {
  const ctx = await setup(t, { token: 'invalid_grant' });
  assert.equal(ctx.token.count(), 1);
  assert.match(lastStatus(ctx.gladys)[1], /Google refused the access/);
  const { refused, salt } = ctx.store.data;
  assert.match(refused.fp, /^[0-9a-f]{2}$/);
  assert.equal(refused.kind, 'grant');
  assert.equal(
    refused.fp,
    fingerprint(salt, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
    }),
  );
  // Broadcasts and the test button: nothing sent, nothing asked.
  const ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.match(ack.error, /^Nothing sent: Google refused the access/);
  const test = await within(ctx.gladys.fake.action('test_connection'), 5000, 'action');
  assert.match(test.data.message.en, /Nothing sent: Google refused the access/);
  assert.equal(ctx.token.count(), 1);
  assert.equal(ctx.google.calls.length, 0);

  // Restart with the same /data: still nothing asked.
  const again = await setup(t, { token: 'ok', store: ctx.store });
  assert.equal(again.token.count(), 0);
  assert.match(lastStatus(again.gladys)[1], /Google refused the access/);

  // A new refresh token (Connect) is always tried; the success removes the refusal.
  await within(
    again.gladys.fake.configUpdated(fullConfig({ refresh_token: NEW_REFRESH_TOKEN })),
    5000,
    'config',
  );
  await until(() => again.token.count() === 1);
  await until(() => ctx.store.data.refused === null);
  noSecret(ctx);
});

test('the refusal fingerprint says nothing about the token: 8 bits, every value reachable', () => {
  const salt = '0'.repeat(32);
  const seen = new Set();
  for (let i = 0; i < 4000; i += 1) {
    seen.add(fingerprint(salt, { clientId: 'c', clientSecret: 's', refreshToken: `t${i}` }));
  }
  // Brute force of the token from the fingerprint: 1 in 256 candidates match.
  assert.equal(seen.size, 256);
});

test('invalid_client: refusal of the client, lifted by a changed secret', async (t) => {
  const ctx = await setup(t, { token: 'invalid_client' });
  assert.match(lastStatus(ctx.gladys)[1], /refused the client ID or the client secret/);
  assert.equal(ctx.store.data.refused.kind, 'client');
  ctx.token.mode = 'ok';
  await within(ctx.gladys.fake.configUpdated(fullConfig()), 5000, 'config');
  assert.equal(ctx.token.count(), 1, 'same credentials: not asked again');
  await within(
    ctx.gladys.fake.configUpdated(fullConfig({ client_secret: 'GOCSPX-other-02' })),
    5000,
    'config',
  );
  await until(() => ctx.token.count() === 2);
  await until(() => lastStatus(ctx.gladys)[0] === true);
});

for (const mode of ['invalid_request', '403', 'garbage', 'huge']) {
  test(`token endpoint ${mode}: not a refusal, renewal spaced (5 s, doubled)`, async (t) => {
    const ctx = await setup(t, { token: mode });
    assert.equal(ctx.store.data.refused, null);
    assert.equal(ctx.app.refusal(), undefined);
    assert.match(lastStatus(ctx.gladys)[1], /Google answered with an error/);
    let ack = await broadcast(ctx.gladys, { message: 'hello' });
    assert.match(ack.error, /^Nothing sent: /);
    assert.equal(ctx.token.count(), 1, 'within 5 s: not asked again');
    await ctx.step(5000);
    ack = await broadcast(ctx.gladys, { message: 'hello' });
    assert.match(ack.error, /^Nothing sent: /);
    assert.equal(ctx.token.count(), 2);
    await ctx.step(9000);
    ack = await broadcast(ctx.gladys, { message: 'hello' });
    assert.match(ack.error, /^Nothing sent: /);
    assert.equal(ctx.token.count(), 2, '10 s after the second failure');
    ctx.token.mode = 'ok';
    await ctx.step(1000);
    ack = await broadcast(ctx.gladys, { message: 'hello' });
    assert.equal(ack.success, true, ack.error);
  });
}

test('token endpoint unreachable: "cannot be reached", not a refusal', async (t) => {
  const ctx = await setup(t, { start: false });
  await ctx.token.close();
  await within(ctx.gladys.connect(), 5000, 'connect');
  await until(() => statuses(ctx.gladys).length > 0);
  assert.match(lastStatus(ctx.gladys)[1], /cannot be reached/);
  assert.equal(ctx.app.refusal(), undefined);
});

test('token endpoint silent: the renewal gives up at 10 s (virtual), the scene acks in time', async (t) => {
  const ctx = await setup(t, { token: 'silent', start: false });
  ctx.gladys.connect();
  await until(() => ctx.token.count() === 1);
  await ctx.step(TIMINGS.tokenTimeout);
  await until(() => statuses(ctx.gladys).length > 0);
  assert.match(lastStatus(ctx.gladys)[1], /cannot be reached/);
});

// --- pauses ---------------------------------------------------------------------------

test('token 503: pause of 60 s kept in /data, then doubled; requests resume after it', async (t) => {
  const ctx = await setup(t, { token: '503' });
  assert.match(lastStatus(ctx.gladys)[1], /slow down/);
  assert.equal(ctx.store.data.pause.level, 0);
  assert.ok(Math.abs(ctx.store.data.pause.until - (NOW + 60_000)) < 1000);
  let ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.match(ack.error, /^Nothing sent: Google asked to slow down/);
  assert.equal(ctx.token.count(), 1);
  await ctx.step(60_001);
  ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(ack.error, 'Nothing sent: Google had a server error.');
  assert.equal(ctx.token.count(), 2);
  assert.equal(ctx.store.data.pause.level, 1);
  assert.ok(Math.abs(ctx.store.data.pause.until - ctx.clock.now - 120_000) < 1000);
  ctx.token.mode = 'ok';
  await ctx.step(120_001);
  ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.store.data.pause, null, 'a success ends the pause');
});

test('token 429 with Retry-After: 120 s honoured', async (t) => {
  const ctx = await setup(t, { token: '429' });
  assert.ok(Math.abs(ctx.store.data.pause.until - (NOW + 120_000)) < 1000);
});

test('a pause in /data is applied at start, without asking Google', async (t) => {
  const data = { ...emptyData(), pause: { until: NOW + 30 * 60_000, level: 3 } };
  const store = new MemoryStore(data, { now: () => NOW });
  const ctx = await setup(t, { store });
  assert.equal(ctx.token.count(), 0);
  assert.match(lastStatus(ctx.gladys)[1], /resume in about 30 min/);
  // A pause ending beyond 6 h from now is a wrong date: ignored.
  const wrong = new MemoryStore(
    { ...emptyData(), pause: { until: NOW + 7 * 3600_000, level: 1 } },
    { now: () => NOW },
  );
  const other = await setup(t, { store: wrong });
  assert.equal(other.token.count(), 1);
});

test('Assistant RESOURCE_EXHAUSTED: nothing sent, pause; UNAVAILABLE: sent without confirmation, pause', async (t) => {
  const ctx = await setup(t, { assistant: 'quota' });
  let ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(ack.error, 'Nothing sent: Google asked to slow down (quota).');
  assert.ok(ctx.store.data.pause);
  ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.match(ack.error, /^Nothing sent: Google asked to slow down: requests resume/);
  assert.equal(ctx.google.calls.length, 1);

  const other = await setup(t, { assistant: 'unavailable' });
  ack = await broadcast(other.gladys, { message: 'hello' });
  assert.equal(
    ack.error,
    'Sent to Google Assistant, without confirmation: Google Assistant had an error.',
  );
  assert.ok(other.store.data.pause);
});

test('Assistant PERMISSION_DENIED: the status names the API, with Google’s words', async (t) => {
  const ctx = await setup(t, { assistant: 'denied' });
  const ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(ack.success, false);
  assert.match(
    ack.error,
    /^Nothing sent: Google Assistant refused the request \(Google Assistant API has not been used/,
  );
  const [connected, message] = lastStatus(ctx.gladys);
  assert.equal(connected, false);
  assert.match(message, /Is the Google Assistant API enabled/);
  assert.equal(ctx.store.data.pause, null, 'not a pause');
  assert.equal(ctx.app.refusal(), undefined, 'not a refusal');
});

test('Assistant answers that are not gRPC or cut: sent, without confirmation', async (t) => {
  const ctx = await setup(t);
  for (const [mode, text] of [
    ['notgrpc', 'the answer of Google Assistant is unreadable.'],
    ['cut', 'the connection to Google Assistant was lost.'],
  ]) {
    ctx.google.mode = mode;
    await ctx.step(TIMINGS.minGap);
    const ack = await broadcast(ctx.gladys, { message: 'hello' });
    assert.equal(ack.error, `Sent to Google Assistant, without confirmation: ${text}`);
  }
});

// --- queue, spacing, window, budget ----------------------------------------------------

test('one request in flight, in order; a full queue refuses; all acks arrive', async (t) => {
  const ctx = await setup(t);
  let release;
  ctx.google.hold = new Promise((resolve) => (release = resolve));
  let peak = 0;
  const watch = setInterval(() => (peak = Math.max(peak, ctx.google.open)), 1);
  t.after(() => clearInterval(watch));
  const acks = [];
  for (let i = 0; i < 6; i += 1)
    acks.push(ctx.gladys.fake.sceneAction('broadcast', { message: `m${i}` }));
  await until(() => ctx.google.calls.length === 1);
  const refused = await within(
    ctx.gladys.fake.sceneAction('broadcast', { message: 'm6' }),
    3000,
    'ack',
  );
  assert.equal(refused.error, 'Nothing sent: too many broadcasts are already waiting.');
  release();
  ctx.google.hold = undefined;
  for (let i = 0; i < 12 && ctx.google.calls.length < 6; i += 1) await ctx.step(TIMINGS.minGap);
  const results = await within(Promise.all(acks), 5000, 'acks');
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, true, true, true],
  );
  assert.deepEqual(
    ctx.google.texts(),
    ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map((m) => `Diffuse ${m}`),
  );
  assert.equal(peak, 1);
});

test('two requests are at least 1 s apart', async (t) => {
  const ctx = await setup(t);
  assert.equal((await broadcast(ctx.gladys, { message: 'a' })).success, true);
  const second = ctx.gladys.fake.sceneAction('broadcast', { message: 'b' });
  await sleep(30);
  assert.equal(ctx.google.calls.length, 1);
  await ctx.step(TIMINGS.minGap - 5);
  await sleep(30);
  assert.equal(ctx.google.calls.length, 1, 'not before the gap');
  await ctx.step(5);
  assert.equal((await within(second, 5000, 'ack')).success, true);
});

test('at most 30 requests in 10 minutes', async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 30; i += 1) {
    const ack = await broadcast(ctx.gladys, { message: `m${i}` });
    assert.equal(ack.success, true, ack.error);
    await ctx.step(TIMINGS.minGap);
  }
  const ack = await broadcast(ctx.gladys, { message: 'one more' });
  assert.equal(ack.error, 'Nothing sent: more than 30 requests to Google Assistant in 10 minutes.');
  assert.equal(ctx.google.calls.length, 30);
  await ctx.step(10 * 60_000);
  assert.equal((await broadcast(ctx.gladys, { message: 'later' })).success, true);
});

test('a silent Assistant: "without confirmation" within the budget, then "nothing sent" when too late', async (t) => {
  const ctx = await setup(t, { assistant: 'silent' });
  const acks = ['a', 'b', 'c'].map((m) => ctx.gladys.fake.sceneAction('broadcast', { message: m }));
  await until(() => ctx.google.calls.length === 1);
  await ctx.step(TIMINGS.assistTimeout);
  // The second one has ~10 s of its 25 s left: sent with that budget.
  await until(() => ctx.google.calls.length === 2);
  await ctx.step(TIMINGS.jobBudget - TIMINGS.assistTimeout);
  const [a, b, c] = await within(Promise.all(acks), 5000, 'acks');
  const late =
    'Sent to Google Assistant, without confirmation: Google Assistant did not answer in time.';
  assert.equal(a.error, late);
  assert.equal(b.error, late);
  assert.equal(c.error, 'Nothing sent: the broadcasts before it took too long.');
  assert.equal(ctx.google.calls.length, 2);
  // Every ack within the 30 s of the scene action.
  assert.ok(ctx.clock.now - NOW <= 30_000, `${ctx.clock.now - NOW} ms`);
});

test('five broadcasts on a slow Assistant (700 ms): all five acks succeed within their budget', async (t) => {
  const ctx = await setup(t);
  ctx.google.handler = (stream) => {
    setTimeout(() => {
      if (stream.destroyed) return;
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end();
    }, 700);
  };
  const acks = [1, 2, 3, 4, 5].map((i) =>
    ctx.gladys.fake.sceneAction('broadcast', { message: `m${i}` }),
  );
  for (let i = 0; i < 40 && ctx.google.calls.length < 5; i += 1) {
    await ctx.step(TIMINGS.minGap);
    await sleep(150);
  }
  const results = await within(Promise.all(acks), 10_000, 'acks');
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, true, true],
  );
});

test('stop(): the queued broadcasts answer "nothing sent", none goes out after', async (t) => {
  const ctx = await setup(t);
  let release;
  ctx.google.hold = new Promise((resolve) => (release = resolve));
  const first = ctx.gladys.fake.sceneAction('broadcast', { message: 'a' });
  const queued = ctx.gladys.fake.sceneAction('broadcast', { message: 'b' });
  await until(() => ctx.google.calls.length === 1);
  ctx.app.stop();
  const ack = await within(queued, 3000, 'ack');
  assert.equal(ack.error, 'Nothing sent: the integration is stopping.');
  release();
  await within(first, 5000, 'first');
  await ctx.step(5000);
  assert.equal(ctx.google.calls.length, 1);
  const late = await broadcast(ctx.gladys, { message: 'c' });
  assert.equal(late.error, 'Nothing sent: the integration is stopping.');
});

// --- /data ------------------------------------------------------------------------------

test('/data unreadable: the refusal held in memory, the file never overwritten, written once readable', async (t) => {
  const store = new MemoryStore(undefined, { state: 'unreadable', now: () => NOW });
  const ctx = await setup(t, { store, token: 'invalid_grant' });
  assert.equal(store.saves, 0);
  assert.equal(ctx.app.refusal(), 'grant');
  const ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.match(ack.error, /refused the access/);
  assert.equal(ctx.token.count(), 1);
  store.state = 'ok';
  await ctx.step(TIMINGS.storeRetry);
  await until(() => store.saves === 1);
  assert.equal(store.data.refused.kind, 'grant');
});

test('/data stuck: the start goes on after 2 s, broadcasts work, one read at a time', async (t) => {
  const store = new MemoryStore(undefined, { now: () => NOW });
  let unstick;
  store.stuckLoad = new Promise((resolve) => (unstick = resolve));
  t.after(() => unstick());
  const ctx = await setup(t, { store, start: false });
  ctx.gladys.connect();
  await until(() => store.loads === 1);
  await ctx.step(TIMINGS.storeTimeout);
  await until(() => lastStatus(ctx.gladys)?.[0] === true);
  assert.equal((await broadcast(ctx.gladys, { message: 'hello' })).success, true);
  await ctx.step(TIMINGS.storeRetry);
  await ctx.step(TIMINGS.storeRetry);
  assert.ok(store.loads <= 2, `loads ${store.loads}`);
});

test('/data not writable: the refusal still holds in memory', async (t) => {
  const store = new MemoryStore(undefined, { now: () => NOW });
  store.failing = true;
  const ctx = await setup(t, { store, token: 'invalid_grant' });
  assert.equal(ctx.app.refusal(), 'grant');
  const ack = await broadcast(ctx.gladys, { message: 'hello' });
  assert.match(ack.error, /refused the access/);
  assert.equal(ctx.token.count(), 1);
});

// --- token life ---------------------------------------------------------------------------

test('the access token is renewed 5 min before it expires, once for concurrent callers', async (t) => {
  const ctx = await setup(t);
  await ctx.step(3600_000 - TIMINGS.refreshMargin - 1000);
  assert.equal((await broadcast(ctx.gladys, { message: 'a' })).success, true);
  assert.equal(ctx.token.count(), 1);
  await ctx.step(2000);
  const both = [ctx.app.getAccessToken(), ctx.app.getAccessToken()];
  await within(Promise.all(both), 3000, 'tokens');
  assert.equal(ctx.token.count(), 2);
});

test('a refresh token rotated by Google is saved in the configuration', async (t) => {
  const ctx = await setup(t, { start: false });
  ctx.token.reply = (req, form, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: ACCESS_TOKEN,
        expires_in: 3599,
        refresh_token: NEW_REFRESH_TOKEN,
      }),
    );
  };
  await within(ctx.gladys.connect(), 5000, 'connect');
  await until(() => ctx.gladys.fake.config.refresh_token === NEW_REFRESH_TOKEN);
  await until(() => lastStatus(ctx.gladys)?.[0] === true);
  ctx.token.reply = undefined;
  assert.equal((await broadcast(ctx.gladys, { message: 'a' })).success, true);
  assert.equal(ctx.token.count(), 1);
});

test('a saved configuration without the off-schema key keeps the refresh token', async (t) => {
  const ctx = await setup(t);
  await within(
    ctx.gladys.fake.configUpdated(fullConfig({ refresh_token: undefined })),
    5000,
    'config',
  );
  assert.equal(ctx.app.config.refreshToken, REFRESH_TOKEN);
  assert.equal((await broadcast(ctx.gladys, { message: 'a' })).success, true);
  assert.equal(ctx.token.count(), 1, 'same credentials: the access token is kept');
});

test('the status is published once per state', async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 3; i += 1) {
    await broadcast(ctx.gladys, { message: `m${i}` });
    await ctx.step(TIMINGS.minGap);
  }
  assert.equal(statuses(ctx.gladys).length, 1);
});

// --- buttons ------------------------------------------------------------------------------

test('"Test the connection" asks the time silently in the configured language', async (t) => {
  const ctx = await setup(t);
  ctx.google.text = 'Il est 9 h 30.';
  const ack = await within(ctx.gladys.fake.action('test_connection'), 5000, 'action');
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.message, {
    en: 'Google Assistant answered: “Il est 9 h 30.”.',
    fr: 'L’Assistant Google a répondu : « Il est 9 h 30. ».',
  });
  assert.deepEqual(ctx.google.texts(), ['quelle heure est-il']);
});

test('"Send a test broadcast": the message, and the failure shown under the button', async (t) => {
  const ctx = await setup(t);
  let ack = await within(
    ctx.gladys.fake.action('test_broadcast', { message: 'Gladys test', room: '' }),
    5000,
    'action',
  );
  assert.deepEqual(ack.data.message, {
    en: 'Accepted by Google Assistant.',
    fr: 'Accepté par l’Assistant Google.',
  });
  assert.deepEqual(ctx.google.texts(), ['Diffuse Gladys test']);
  ack = await within(ctx.gladys.fake.action('test_broadcast', { message: '' }), 5000, 'action');
  assert.equal(ack.data.message.en, 'Nothing sent: the message is empty.');
  assert.equal(ack.data.message.fr, 'Rien envoyé : le message est vide.');
});

test('the scene action resolves no output (undefined), even on success', async (t) => {
  const ctx = await setup(t);
  const ack = await broadcast(ctx.gladys, { message: 'a' });
  assert.equal(ack.success, true);
  assert.equal(ack.data, undefined);
});

test('a broadcast after a long idle: virtual time runs, the token is renewed, no wall clock used', async (t) => {
  const ctx = await setup(t);
  await ctx.step(5 * 3600_000);
  const ack = await broadcastWhileAdvancing(ctx, { message: 'late' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.token.count(), 2);
});

test('a token renewal slower than the budget: "nothing sent" within the 25 s of the broadcast', async (t) => {
  const ctx = await setup(t);
  // The access token expires: the next broadcast must renew it.
  await ctx.step(3600_000);
  ctx.token.mode = 'silent';
  const started = ctx.clock.now;
  const ack = ctx.gladys.fake.sceneAction('broadcast', { message: 'a' });
  await until(() => ctx.token.count() === 2);
  await ctx.step(TIMINGS.jobBudget - TIMINGS.minStart);
  const result = await within(ack, 5000, 'ack');
  assert.equal(
    result.error,
    'Nothing sent: Google cannot be reached for now; the next broadcast tries again.',
  );
  assert.ok(ctx.clock.now - started <= TIMINGS.jobBudget);
  assert.equal(ctx.google.calls.length, 0);
});

test('new client credentials after a token error: tried at once, no waiting on the old failure', async (t) => {
  const ctx = await setup(t, { token: '403' });
  assert.equal(ctx.token.count(), 1);
  ctx.token.mode = 'ok';
  await within(
    ctx.gladys.fake.configUpdated(fullConfig({ client_secret: 'GOCSPX-other-03' })),
    5000,
    'config',
  );
  await until(() => ctx.token.count() === 2);
  await until(() => lastStatus(ctx.gladys)[0] === true);
});

for (const [mode, reason] of [
  ['invalid_grant', /Google refused the access/],
  ['503', /Google asked to slow down/],
]) {
  test(`a ${mode} met by the first queued broadcast: the next one does not ask Google again`, async (t) => {
    const ctx = await setup(t);
    await ctx.step(3600_000); // the access token expired
    ctx.token.mode = mode;
    const acks = ['a', 'b'].map((m) => ctx.gladys.fake.sceneAction('broadcast', { message: m }));
    for (let i = 0; i < 10; i += 1) await ctx.step(TIMINGS.minGap);
    const [a, b] = await within(Promise.all(acks), 5000, 'acks');
    assert.match(a.error, /^Nothing sent: /);
    assert.match(b.error, reason);
    assert.equal(ctx.token.count(), 2, 'one renewal at start, one for the first broadcast');
    assert.equal(ctx.google.calls.length, 0);
  });
}

for (const [mode, reason] of [
  ['invalid_grant', /^Nothing sent: Google refused the access/],
  ['503', /^Nothing sent: Google asked to slow down/],
]) {
  test(`after a ${mode}, a burst of broadcasts is refused at once, never queued`, async (t) => {
    const ctx = await setup(t, { token: mode });
    const acks = await within(
      Promise.all(
        [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
          ctx.gladys.fake.sceneAction('broadcast', { message: `m${i}` }),
        ),
      ),
      3000,
      'acks',
    );
    for (const ack of acks) assert.match(ack.error, reason);
    assert.equal(ctx.token.count(), 1);
  });
}

test('the window full: no token renewal either', async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await broadcast(ctx.gladys, { message: `m${i}` })).success, true);
    await ctx.step(TIMINGS.minGap);
  }
  ctx.app.access = undefined; // the next request would need a renewal
  const ack = await broadcast(ctx.gladys, { message: 'one more' });
  assert.match(ack.error, /more than 30 requests/);
  assert.equal(ctx.token.count(), 1);
});

test('a queued broadcast whose renewal is slow: answered within its own 25 s', async (t) => {
  const ctx = await setup(t, { assistant: 'silent' });
  const start = ctx.clock.now;
  const first = ctx.gladys.fake.sceneAction('broadcast', { message: 'a' });
  let doneAt;
  const second = ctx.gladys.fake.sceneAction('broadcast', { message: 'b' }).then((r) => {
    doneAt = ctx.clock.now;
    return r;
  });
  await until(() => ctx.google.calls.length === 1);
  ctx.token.mode = 'silent';
  ctx.app.access = undefined; // the second one must renew the token
  await ctx.step(TIMINGS.assistTimeout);
  await within(first, 5000, 'first');
  await until(() => ctx.token.count() === 2);
  for (let i = 0; i < 20 && doneAt === undefined; i += 1) await ctx.step(1000);
  const ack = await within(second, 5000, 'second');
  assert.match(ack.error, /^Nothing sent: /);
  // Given up at its deadline minus the start margin (22 s), not at the 10 s of the token call.
  assert.ok(doneAt - start <= TIMINGS.jobBudget - TIMINGS.minStart + 1000, `${doneAt - start} ms`);
  assert.equal(ctx.google.calls.length, 1);
});
