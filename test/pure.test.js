// -----------------------------------------------------------------------------
// Pure functions: the protobuf bytes, the texts, the OAuth helpers, the
// configuration and the /data sanitizer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { BROADCAST_PHRASES, LANGUAGES, TEST_QUERIES, TIMINGS } from '../src/constants.js';
import {
  buildAuthorizeUrl,
  createPkce,
  grantsAssistant,
  parseRetryAfter,
  sameState,
} from '../src/oauth.js';
import { decodeAssistResponse, encodeAssistRequest, fields } from '../src/proto.js';
import { emptyData, sanitize } from '../src/store.js';
import { broadcastCommand, cleanText, normalizeField } from '../src/text.js';
import { audioMessage, responseMessage } from './helpers/fakeGoogle.js';

test('AssistRequest: the exact bytes of the official message (fields in number order)', () => {
  // Computed by hand from embedded_assistant.proto, as protobuf serializes it:
  // config { audio_out_config { MP3, 24000, 100 }, dialog_state_in { "en-US",
  // is_new_conversation }, device_config { "default", "default" }, "hi" }.
  const expected = [
    '0a2d',
    '1208' + '0802' + '10c0bb01' + '1864',
    '1a09' + '1205' + Buffer.from('en-US').toString('hex') + '3801',
    '2212' +
      '0a07' +
      Buffer.from('default').toString('hex') +
      '1a07' +
      Buffer.from('default').toString('hex'),
    '3202' + Buffer.from('hi').toString('hex'),
  ].join('');
  const bytes = encodeAssistRequest({
    text: 'hi',
    languageCode: 'en-US',
    deviceId: 'default',
    deviceModelId: 'default',
  });
  assert.equal(bytes.toString('hex'), expected);
});

test('AssistRequest: long UTF-8 texts get multi-byte lengths', () => {
  const text = 'é'.repeat(500);
  const bytes = encodeAssistRequest({
    text,
    languageCode: 'fr-FR',
    deviceId: 'd',
    deviceModelId: 'm',
  });
  const [[field, , config]] = [...fields(bytes)];
  assert.equal(field, 1);
  const query = [...fields(config)].find(([f]) => f === 6)[2];
  assert.equal(query.toString('utf8'), text);
});

test('AssistResponse: the display text, unknown fields skipped, malformed refused', () => {
  assert.deepEqual(decodeAssistResponse(responseMessage('Il est 9 h')), { text: 'Il est 9 h' });
  assert.deepEqual(decodeAssistResponse(responseMessage()), { text: undefined });
  assert.deepEqual(decodeAssistResponse(audioMessage(70_000)), { text: undefined });
  // Unknown varint, fixed64 and fixed32 fields are skipped.
  const extra = Buffer.from([0x08, 0x01, 0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x1d, 1, 2, 3, 4]);
  assert.deepEqual(decodeAssistResponse(Buffer.concat([extra, responseMessage('ok')])), {
    text: 'ok',
  });
  for (const bad of [
    Buffer.from([0x2a, 0x10, 0x0a]), // length beyond the buffer
    Buffer.from([0x0b]), // group (wire type 3)
    Buffer.from([0x00]), // field 0
    Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), // varint > 10 bytes
    Buffer.from([0x08, 0x80]), // truncated varint
  ]) {
    assert.throws(() => decodeAssistResponse(bad), undefined, bad.toString('hex'));
  }
});

test('broadcast phrases: every language of the list has one, and a test query', () => {
  for (const code of LANGUAGES) {
    const base = code.split('-')[0];
    assert.ok(BROADCAST_PHRASES[base], code);
    assert.ok(TEST_QUERIES[base], code);
    const [home, room] = BROADCAST_PHRASES[base];
    assert.ok(home.includes('{0}') && !home.includes('{1}'));
    assert.ok(room.includes('{0}') && room.includes('{1}'));
  }
  assert.equal(broadcastCommand(BROADCAST_PHRASES.fr, 'a $& b', ''), 'Diffuse a $& b');
  assert.equal(
    broadcastCommand(BROADCAST_PHRASES.fr, 'x {1} y', 'Salon'),
    'Diffuse dans Salon x {1} y',
  );
  assert.equal(broadcastCommand(BROADCAST_PHRASES.en, 'x', 'Kitchen'), 'broadcast to Kitchen x');
});

test('normalizeField: one line, bounded in characters, never echoing an error', () => {
  assert.deepEqual(normalizeField('  a\r\n\tb  ', 10, { required: true }), { value: 'a b' });
  assert.deepEqual(normalizeField('a b‮c​d', 10, { required: true }), { value: 'a b c d' });
  assert.deepEqual(normalizeField('', 10, { required: true }), { error: 'empty' });
  assert.deepEqual(normalizeField(null, 10, { required: false }), { value: '' });
  assert.deepEqual(normalizeField(12, 10, { required: true }), { value: '12' });
  assert.deepEqual(normalizeField(true, 10, { required: true }), { error: 'type' });
  assert.deepEqual(normalizeField('😀'.repeat(10), 10, { required: true }), {
    value: '😀'.repeat(10),
  });
  assert.deepEqual(normalizeField('😀'.repeat(11), 10, { required: true }), { error: 'long' });
  assert.equal(cleanText('x'.repeat(300), 200).length, 200);
  assert.equal(cleanText('a\u0000b', 10), 'a b');
});

test('normalizeConfig: client fields token-like, language from the list, problems in order', () => {
  const ok = normalizeConfig({
    client_id: ' id.apps.googleusercontent.com ',
    client_secret: 'GOCSPX-x',
    language: 'fr-FR',
    refresh_token: '1//r',
  });
  assert.deepEqual(ok, {
    clientId: 'id.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-x',
    refreshToken: '1//r',
    language: 'fr-FR',
    problem: undefined,
  });
  assert.equal(normalizeConfig({ client_secret: 'x', language: 'fr-FR' }).problem, 'client');
  assert.equal(normalizeConfig({ client_id: 'a b', client_secret: 'x' }).problem, 'client');
  assert.equal(normalizeConfig({ client_id: 'a', client_secret: 'x\ny' }).problem, 'client');
  assert.equal(
    normalizeConfig({ client_id: 'a', client_secret: 'x', language: 'fr' }).problem,
    'language',
  );
  assert.equal(
    normalizeConfig({ client_id: 'a', client_secret: 'x', refresh_token: 'a\r\nb' }).refreshToken,
    undefined,
  );
  assert.equal(normalizeConfig(null).problem, 'client');
});

test('OAuth helpers: PKCE pair, constant-time state check, scope check', () => {
  const { state, verifier, challenge } = createPkce();
  assert.match(verifier, /^[\w-]{64}$/);
  assert.notEqual(challenge, verifier);
  assert.ok(sameState(state, `${state}`));
  assert.ok(!sameState(state, `${state}x`));
  assert.ok(!sameState(undefined, state));
  assert.ok(grantsAssistant('openid https://www.googleapis.com/auth/assistant-sdk-prototype'));
  assert.ok(!grantsAssistant('https://www.googleapis.com/auth/assistant-sdk-prototype-x'));
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'c',
      redirectUri: 'https://r/x?y=1',
      state: 's',
      challenge: 'h',
    }),
  );
  assert.equal(url.searchParams.get('redirect_uri'), 'https://r/x?y=1');
});

test('Retry-After: seconds or a date against the answer’s Date header, bounded', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter('1'), TIMINGS.pauseMin);
  assert.equal(parseRetryAfter('999999'), TIMINGS.pauseMax);
  assert.equal(
    parseRetryAfter('Wed, 21 Oct 2026 07:30:00 GMT', 'Wed, 21 Oct 2026 07:25:00 GMT'),
    300_000,
  );
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:30:00 GMT'), undefined, 'no Date: unknown');
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});

test('sanitize: unknown keys dropped, fingerprints checked, impossible pauses refused', () => {
  const now = 1_800_000_000_000;
  const salt = 'a'.repeat(32);
  assert.deepEqual(
    sanitize({ salt, refused: { fp: 'ab', kind: 'grant', at: now - 5 }, x: 1 }, now),
    {
      salt,
      refused: { fp: 'ab', kind: 'grant', at: now - 5 },
      pause: null,
    },
  );
  assert.equal(sanitize({ salt, refused: { fp: 'abc', kind: 'grant' } }, now).refused, null);
  assert.equal(sanitize({ salt, refused: { fp: 'ab', kind: 'other' } }, now).refused, null);
  assert.equal(
    sanitize({ salt, refused: { fp: 'ab', kind: 'client', at: now + 1e9 } }, now).refused.at,
    now,
  );
  assert.deepEqual(sanitize({ salt, pause: { until: now + 60_000, level: 2 } }, now).pause, {
    until: now + 60_000,
    level: 2,
    source: 'assistant',
  });
  assert.equal(
    sanitize({ salt, pause: { until: now + 60_000, level: 2, source: 'token' } }, now).pause.source,
    'token',
  );
  assert.equal(sanitize({ salt, pause: { until: now + 7 * 3600_000, level: 2 } }, now).pause, null);
  assert.equal(sanitize({ salt, pause: { until: 'x', level: 2 } }, now).pause, null);
  assert.notEqual(sanitize({ salt: 'short' }, now).salt, 'short');
  assert.deepEqual(Object.keys(sanitize([], now)), Object.keys(emptyData()));
  // No prototype pollution through the file.
  const polluted = sanitize(JSON.parse('{"__proto__":{"polluted":1},"salt":"x"}'), now);
  assert.equal(polluted.polluted, undefined);
  assert.equal({}.polluted, undefined);
});
