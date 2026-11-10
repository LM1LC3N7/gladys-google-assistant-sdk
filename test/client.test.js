// -----------------------------------------------------------------------------
// The gRPC client against a fake Assistant API over real HTTP/2 + TLS: the
// request it writes, and what each kind of answer becomes (sent or not).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistError, AssistantClient, decodeGrpcMessage } from '../src/assistant.js';
import { USER_AGENT } from '../src/constants.js';
import { ACCESS_TOKEN, TLS, startAssistantServer } from './helpers/fakeGoogle.js';
import { createFakeClock } from './helpers/fakeTimers.js';
import { refusePort, sleep, until, within } from './helpers/net.js';

async function setup(t) {
  const google = await startAssistantServer();
  t.after(() => google.close());
  const { timers, advance } = createFakeClock(0);
  const client = new AssistantClient({ origin: google.origin, tls: TLS, timers });
  const call = (extra = {}) =>
    client.assist({
      text: 'Diffuse bonjour',
      languageCode: 'fr-FR',
      accessToken: ACCESS_TOKEN,
      deviceId: 'default',
      deviceModelId: 'default',
      timeout: 15_000,
      ...extra,
    });
  return { google, client, call, advance };
}

const failure = async (promise) => {
  try {
    await within(promise, 5000, 'assist');
  } catch (err) {
    return err;
  }
  throw new Error('resolved');
};

test('writes one AssistRequest with the query, the language and the headers', async (t) => {
  const { google, call } = await setup(t);
  google.text = 'OK';
  const result = await within(call(), 5000, 'assist');
  assert.deepEqual(result, { text: 'OK' });
  assert.equal(google.calls.length, 1);
  const [{ headers, request }] = google.calls;
  assert.equal(headers[':path'], '/google.assistant.embedded.v1alpha2.EmbeddedAssistant/Assist');
  assert.equal(headers['content-type'], 'application/grpc');
  assert.equal(headers.te, 'trailers');
  assert.equal(headers['user-agent'], USER_AGENT);
  assert.equal(headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(headers['grpc-timeout'], '15S');
  assert.equal(headers['grpc-accept-encoding'], 'identity');
  assert.deepEqual(request, {
    audio: true,
    language: 'fr-FR',
    newConversation: true,
    deviceId: 'default',
    deviceModelId: 'default',
    text: 'Diffuse bonjour',
  });
});

test('an answer without display text resolves without text', async (t) => {
  const { call } = await setup(t);
  assert.deepEqual(await within(call(), 5000, 'assist'), { text: undefined });
});

const NOT_EXECUTED = [
  ['unauth', 16],
  ['denied', 7],
  ['quota', 8],
  ['invalid', 3],
];
for (const [mode, code] of NOT_EXECUTED) {
  test(`gRPC status ${code} (${mode}): an error, nothing executed`, async (t) => {
    const { google, call } = await setup(t);
    google.mode = mode;
    const err = await failure(call());
    assert.ok(err instanceof AssistError);
    assert.equal(err.kind, 'grpc');
    assert.equal(err.code, code);
    assert.equal(err.sent, false);
    assert.ok(!err.message.includes(ACCESS_TOKEN));
  });
}

test('gRPC UNAVAILABLE: sent, without certainty', async (t) => {
  const { google, call } = await setup(t);
  google.mode = 'unavailable';
  const err = await failure(call());
  assert.equal(err.code, 14);
  assert.equal(err.sent, true);
});

test('a trailers-only answer is read, its message percent-decoded', async (t) => {
  const { google, call } = await setup(t);
  google.mode = 'trailers-only';
  const err = await failure(call());
  assert.equal(err.code, 7);
  assert.equal(err.message, 'denied here');
});

test('HTTP 503 and 429 of the front end: mapped, 429 never executed', async (t) => {
  const { google, call } = await setup(t);
  google.mode = 'http503';
  let err = await failure(call());
  assert.equal(err.kind, 'http');
  assert.equal(err.status, 503);
  assert.equal(err.code, 14);
  google.mode = 'http429';
  err = await failure(call());
  assert.equal(err.code, 8);
  assert.equal(err.sent, false);
});

test('an answer that is not gRPC, unreadable, cut or reset: errors, sent', async (t) => {
  const { google, call } = await setup(t);
  for (const [mode, kind, text] of [
    ['notgrpc', 'answer', /not gRPC/],
    ['garbage', 'answer', /unreadable/],
    ['compressed', 'answer', /unreadable/],
    ['cut', 'lost'],
    ['reset', 'lost'],
  ]) {
    google.mode = mode;
    const err = await failure(call());
    assert.equal(err.kind, kind, mode);
    if (text) assert.match(err.message, text, mode);
    assert.equal(err.sent, true, mode);
  }
});

test('a frame announced larger than the bound is cut before it arrives', async (t) => {
  const { google, call } = await setup(t);
  google.mode = 'bigframe';
  const err = await failure(call());
  assert.equal(err.kind, 'answer');
  await until(() => google.open === 0);
});

test('an endless answer is cut at the bound', async (t) => {
  const { google, call } = await setup(t);
  google.mode = 'flood';
  const err = await failure(call());
  assert.equal(err.kind, 'answer');
  assert.match(err.message, /too large/);
  await until(() => google.open === 0);
});

test('a silent server: timeout on the injected clock, sent, the stream closed', async (t) => {
  const { google, call, advance } = await setup(t);
  google.mode = 'silent';
  const pending = call({ timeout: 2000 });
  await until(() => google.calls.length === 1);
  await advance(1999);
  await sleep(20);
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await sleep(10);
  assert.equal(settled, false, 'not before the budget');
  await advance(1);
  const err = await failure(pending);
  assert.equal(err.kind, 'timeout');
  assert.equal(err.sent, true);
  await until(() => google.open === 0);
});

test('no server: offline, nothing sent', async (t) => {
  const port = await refusePort();
  const { timers } = createFakeClock(0);
  const client = new AssistantClient({ origin: `https://127.0.0.1:${port}`, tls: TLS, timers });
  const err = await failure(
    client.assist({
      text: 'x',
      languageCode: 'en-US',
      accessToken: 'a',
      deviceId: 'd',
      deviceModelId: 'd',
      timeout: 5000,
    }),
  );
  assert.equal(err.kind, 'offline');
  assert.equal(err.sent, false);
  void t;
});

test('a certificate that is not trusted: offline, nothing sent, no request', async (t) => {
  const google = await startAssistantServer();
  t.after(() => google.close());
  const { timers } = createFakeClock(0);
  const client = new AssistantClient({ origin: google.origin, timers });
  const err = await failure(
    client.assist({
      text: 'x',
      languageCode: 'en-US',
      accessToken: ACCESS_TOKEN,
      deviceId: 'd',
      deviceModelId: 'd',
      timeout: 5000,
    }),
  );
  assert.equal(err.kind, 'offline');
  assert.equal(err.sent, false);
  assert.equal(google.calls.length, 0);
});

test('grpc-message: decoded, controls removed, bounded', () => {
  assert.equal(decodeGrpcMessage('a%20b%0Ac'), 'a b c');
  assert.equal(decodeGrpcMessage('%E0%A4%A'), '%E0%A4%A');
  assert.ok(decodeGrpcMessage('x'.repeat(5000)).length <= 200);
  assert.equal(decodeGrpcMessage(undefined), '');
});
