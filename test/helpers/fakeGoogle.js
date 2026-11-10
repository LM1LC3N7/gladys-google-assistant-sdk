// -----------------------------------------------------------------------------
// Fake Google on real loopback sockets:
// - the OAuth token endpoint (HTTP/1.1), its answer chosen per test;
// - the Assistant API (gRPC over HTTP/2 with TLS, the test certificate of
//   gladys-testkit), its answer chosen per test.
// Every request is recorded (form fields, headers, the decoded text query).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createSecureServer, constants as h2 } from 'node:http2';
import { fields } from '../../src/proto.js';

export const CLIENT_ID = '123-abc.apps.googleusercontent.com';
export const CLIENT_SECRET = 'GOCSPX-test-secret-0001';
export const REFRESH_TOKEN = '1//refresh-token-secret-0001';
export const ACCESS_TOKEN = 'ya29.access-token-secret-0001';
export const NEW_REFRESH_TOKEN = '1//refresh-token-secret-0002';
export const SECRETS = [CLIENT_SECRET, REFRESH_TOKEN, ACCESS_TOKEN, NEW_REFRESH_TOKEN];

const cert = readFileSync(new URL('../fixtures/device.crt', import.meta.url));
const key = readFileSync(new URL('../fixtures/device.key', import.meta.url));
export const TLS = { ca: cert, checkServerIdentity: () => undefined };

/**
 * Closes a server: its connections destroyed first, then a bounded wait (a
 * test fails, never hangs, even under a mutant that leaks a connection).
 */
function boundedClose(server, destroyAll, ms = 3000) {
  destroyAll();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not closed in ${ms} ms`)), ms);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The token endpoint. `fake.mode` picks the answer; `fake.reply(req, form, res)` overrides it. */
export async function startTokenServer() {
  const fake = {
    mode: 'ok',
    requests: [],
    accessToken: ACCESS_TOKEN,
    issued: 0,
    expiresIn: 3600,
    reply: undefined,
    hold: undefined, // a promise the answer waits for
  };
  const sockets = new Set();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      fake.requests.push({ form, headers: req.headers });
      if (fake.hold) await fake.hold;
      if (fake.reply) return fake.reply(req, form, res);
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      switch (fake.mode) {
        case 'ok':
          fake.issued += 1;
          return json(200, {
            access_token: `${fake.accessToken}${fake.issued > 1 ? `-${fake.issued}` : ''}`,
            expires_in: fake.expiresIn,
            scope: 'https://www.googleapis.com/auth/assistant-sdk-prototype',
            token_type: 'Bearer',
            ...(form.grant_type === 'authorization_code'
              ? { refresh_token: NEW_REFRESH_TOKEN }
              : {}),
          });
        case 'invalid_grant':
          return json(400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          });
        case 'invalid_client':
          return json(401, {
            error: 'invalid_client',
            error_description: 'The OAuth client was not found.',
          });
        case 'invalid_request':
          return json(400, { error: 'invalid_request' });
        case '403':
          return json(403, { error: { code: 403, message: 'forbidden' } });
        case '429':
          return json(429, { error: 'rate' }, { 'retry-after': '120' });
        case '503':
          return json(503, { error: 'backend' });
        case 'garbage':
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html>oops</html>');
        case 'huge':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(`{"access_token":"${'x'.repeat(64 * 1024)}`);
          return res.end('"}');
        case 'silent':
          return undefined;
        default:
          throw new Error(`mode ${fake.mode}`);
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${server.address().port}/token`;
  fake.count = (grant) => fake.requests.filter((r) => !grant || r.form.grant_type === grant).length;
  fake.close = () => boundedClose(server, () => sockets.forEach((s) => s.destroy()));
  return fake;
}

/** The text query and language of an AssistRequest (independent of the app's encoder). */
export function readAssistRequest(buffer) {
  const out = {};
  for (const [field, , value] of fields(buffer)) {
    if (field !== 1) continue;
    for (const [f, , v] of fields(value)) {
      if (f === 6) out.text = v.toString('utf8');
      if (f === 3) {
        for (const [g, , w] of fields(v)) {
          if (g === 2) out.language = w.toString('utf8');
          if (g === 7) out.newConversation = w === 1;
        }
      }
      if (f === 4) {
        for (const [g, , w] of fields(v)) {
          if (g === 1) out.deviceId = w.toString('utf8');
          if (g === 3) out.deviceModelId = w.toString('utf8');
        }
      }
      if (f === 2) out.audio = true;
    }
  }
  return out;
}

const frame = (message) => {
  const out = Buffer.alloc(5 + message.length);
  out.writeUInt32BE(message.length, 1);
  message.copy(out, 5);
  return out;
};

/** An AssistResponse with audio and, optionally, a display text. */
export function responseMessage(text) {
  const parts = [Buffer.from([0x1a, 0x04, 0x0a, 0x02, 0x01, 0x02])]; // audio_out { audio_data }
  if (text) {
    const t = Buffer.from(text);
    const inner = Buffer.concat([Buffer.from([0x0a, t.length]), t]);
    parts.push(Buffer.concat([Buffer.from([0x2a, inner.length]), inner]));
  }
  return Buffer.concat(parts);
}

const varint = (n) => {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
};

/** An AssistResponse carrying `size` bytes of audio (valid protobuf). */
export function audioMessage(size) {
  const audio = Buffer.concat([Buffer.from([0x0a]), varint(size), Buffer.alloc(size, 1)]);
  return Buffer.concat([Buffer.from([0x1a]), varint(audio.length), audio]);
}

/** The Assistant API. `fake.mode` picks the answer; `fake.handler(stream, call)` overrides it. */
export async function startAssistantServer() {
  const fake = {
    mode: 'ok',
    calls: [],
    text: undefined,
    handler: undefined,
    hold: undefined,
    open: 0,
    accepted: [ACCESS_TOKEN],
  };
  const sessions = new Set();
  const server = createSecureServer({ key, cert, allowHTTP1: false });
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  server.on('stream', (stream, headers) => {
    fake.open += 1;
    stream.on('close', () => (fake.open -= 1));
    stream.on('error', () => {});
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', async () => {
      const body = Buffer.concat(chunks);
      const call = { headers, body, request: undefined };
      try {
        call.request = readAssistRequest(body.subarray(5, 5 + body.readUInt32BE(1)));
      } catch {
        call.request = { unreadable: true };
      }
      fake.calls.push(call);
      if (fake.hold) await fake.hold;
      if (stream.destroyed) return;
      if (fake.handler) return fake.handler(stream, call);
      const grpc = (code, message) => {
        stream.respond(
          { ':status': 200, 'content-type': 'application/grpc' },
          { waitForTrailers: true },
        );
        stream.on('wantTrailers', () =>
          stream.sendTrailers({
            'grpc-status': String(code),
            ...(message ? { 'grpc-message': message } : {}),
          }),
        );
        stream.end();
      };
      const token = String(headers.authorization ?? '').replace(/^Bearer /, '');
      switch (fake.mode) {
        case 'ok':
          if (!fake.accepted.some((a) => token.startsWith(a)))
            return grpc(16, 'Request had invalid authentication credentials.');
          stream.respond(
            { ':status': 200, 'content-type': 'application/grpc' },
            { waitForTrailers: true },
          );
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.write(frame(responseMessage(fake.text)));
          return stream.end();
        case 'unauth':
          return grpc(16, 'Request had invalid authentication credentials.');
        case 'denied':
          return grpc(
            7,
            'Google Assistant API has not been used in project 1234 before or it is disabled.',
          );
        case 'quota':
          return grpc(8, 'Quota exceeded');
        case 'unavailable':
          return grpc(14, 'The service is currently unavailable.');
        case 'invalid':
          return grpc(3, 'Invalid argument');
        case 'trailers-only':
          stream.respond(
            {
              ':status': 200,
              'content-type': 'application/grpc',
              'grpc-status': '7',
              'grpc-message': 'denied%20here',
            },
            { endStream: true },
          );
          return undefined;
        case 'http503':
          stream.respond({ ':status': 503 });
          return stream.end('busy');
        case 'http429':
          stream.respond({ ':status': 429 });
          return stream.end('slow down');
        case 'notgrpc':
          stream.respond({ ':status': 200, 'content-type': 'text/html' });
          return stream.end('<html>');
        case 'bigframe': {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
          const head = Buffer.alloc(5);
          head.writeUInt32BE(64 * 1024 * 1024, 1);
          stream.write(head);
          return stream.write(Buffer.alloc(1024));
        }
        case 'flood': {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
          const piece = frame(audioMessage(400 * 1024));
          const pump = () => {
            while (!stream.destroyed && stream.write(piece));
            if (!stream.destroyed) stream.once('drain', pump);
          };
          return pump();
        }
        case 'garbage':
          stream.respond(
            { ':status': 200, 'content-type': 'application/grpc' },
            { waitForTrailers: true },
          );
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.write(frame(Buffer.from([0x0f, 0xff, 0xff])));
          return stream.end();
        case 'compressed': {
          stream.respond(
            { ':status': 200, 'content-type': 'application/grpc' },
            { waitForTrailers: true },
          );
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          const f = frame(responseMessage('x'));
          f[0] = 1;
          stream.write(f);
          return stream.end();
        }
        case 'cut':
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
          stream.write(frame(responseMessage()).subarray(0, 7));
          return stream.close(h2.NGHTTP2_INTERNAL_ERROR);
        case 'refused':
          return stream.close(h2.NGHTTP2_REFUSED_STREAM);
        case 'reset':
          return stream.close(h2.NGHTTP2_INTERNAL_ERROR);
        case 'silent':
          return undefined;
        default:
          throw new Error(`mode ${fake.mode}`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `https://127.0.0.1:${server.address().port}`;
  fake.texts = () => fake.calls.map((c) => c.request.text);
  fake.sessions = () => sessions.size;
  fake.close = () => boundedClose(server, () => sessions.forEach((s) => s.destroy()));
  return fake;
}
