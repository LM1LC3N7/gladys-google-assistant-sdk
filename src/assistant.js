// -----------------------------------------------------------------------------
// One call to the Google Assistant API: gRPC over HTTP/2 (node:http2), by
// hand, for one unary-like exchange of the bidirectional `Assist` stream (one
// AssistRequest carrying the text query, then the responses until the
// trailers). No gRPC library: @grpc/grpc-js plus protobufjs cost far more
// than the two messages need.
//
// - a new HTTP/2 session per call, closed at the end (a broadcast is rare);
// - one budget for the whole call (`timeout`, on the injected timers);
// - the answer read frame by frame, a frame larger than LIMITS.frameBytes or
//   an answer larger than LIMITS.answerBytes cut before it is received in
//   full;
// - an error that says whether the request may have reached Google (`sent`):
//   a connection that failed never did; an answer that says "not
//   authenticated", "denied", "quota" or "invalid" means nothing was done.
// The access token travels in the `authorization` header only: never in an
// error, never in a log.
// -----------------------------------------------------------------------------

import { connect, constants as h2 } from 'node:http2';
import { ASSIST_ORIGIN, ASSIST_PATH, LIMITS, USER_AGENT } from './constants.js';
import { decodeAssistResponse, encodeAssistRequest } from './proto.js';
import { cleanText } from './text.js';

// gRPC status codes that mean "the call was not executed".
export const GRPC = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
};
const NOT_EXECUTED = new Set([3, 5, 7, 8, 9, 12, 16]);

/**
 * kind:
 * - `offline`: no connection to Google (nothing sent);
 * - `timeout`: no complete answer within the budget;
 * - `lost`: the stream ended without a status;
 * - `answer`: an answer that is not gRPC, or too large;
 * - `http`: an HTTP status other than 200 (`status`);
 * - `grpc`: a gRPC status other than OK (`code`).
 */
export class AssistError extends Error {
  constructor(message, kind, { sent = false, code, status } = {}) {
    super(message);
    this.name = 'AssistError';
    this.kind = kind;
    this.sent = sent;
    this.code = code;
    this.status = status;
  }
}

/** grpc-message is percent-encoded (gRPC over HTTP/2 spec); kept short and printable. */
export function decodeGrpcMessage(value) {
  if (typeof value !== 'string') return '';
  let text = value.slice(0, 4 * LIMITS.googleText);
  try {
    text = decodeURIComponent(text);
  } catch {
    // keep it as received
  }
  return cleanText(text, LIMITS.googleText);
}

/** An HTTP status of the Google front end, as gRPC status (gRPC spec, HTTP to gRPC mapping). */
function httpToGrpc(status) {
  if (status === 401) return GRPC.UNAUTHENTICATED;
  if (status === 403) return GRPC.PERMISSION_DENIED;
  if (status === 404) return GRPC.UNIMPLEMENTED;
  if (status === 429) return GRPC.RESOURCE_EXHAUSTED;
  if ([502, 503, 504].includes(status)) return GRPC.UNAVAILABLE;
  return GRPC.UNKNOWN;
}

export class AssistantClient {
  /**
   * @param {object} options `origin` and `tls` (connect options) for the
   * tests only; `timers` the injected timers.
   */
  constructor({ origin = ASSIST_ORIGIN, tls = {}, timers = globalThis } = {}) {
    this.origin = origin;
    this.tls = tls;
    this.timers = timers;
  }

  /**
   * Sends one text query. Resolves `{ text }` (the display text Google may
   * return, usually none), rejects an AssistError.
   */
  assist({ text, languageCode, accessToken, deviceId, deviceModelId, timeout }) {
    const message = encodeAssistRequest({ text, languageCode, deviceId, deviceModelId });
    const frame = Buffer.alloc(5 + message.length);
    frame.writeUInt32BE(message.length, 1);
    message.copy(frame, 5);

    return new Promise((resolve, reject) => {
      let done = false;
      let sent = false;
      let session;
      let stream;
      let timer;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        try {
          stream?.close(h2.NGHTTP2_CANCEL);
        } catch {
          // already closed
        }
        session?.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      timer = this.timers.setTimeout(
        () =>
          finish(new AssistError('Google Assistant did not answer in time', 'timeout', { sent })),
        timeout,
      );

      try {
        session = connect(this.origin, { ...this.tls, maxSessionMemory: 4 });
      } catch {
        finish(new AssistError('Google Assistant is unreachable', 'offline'));
        return;
      }
      session.on('error', () => {
        finish(
          sent
            ? new AssistError('The connection to Google Assistant was lost', 'lost', { sent })
            : new AssistError('Google Assistant is unreachable', 'offline'),
        );
      });
      session.on('goaway', () => {});

      session.once('connect', () => {
        if (done) return;
        stream = session.request({
          [h2.HTTP2_HEADER_METHOD]: 'POST',
          [h2.HTTP2_HEADER_PATH]: ASSIST_PATH,
          [h2.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
          [h2.HTTP2_HEADER_USER_AGENT]: USER_AGENT,
          te: 'trailers',
          'grpc-accept-encoding': 'identity',
          'grpc-timeout': `${Math.max(1, Math.ceil(timeout / 1000))}S`,
          authorization: `Bearer ${accessToken}`,
        });
        let headersSeen = false;
        let pending = Buffer.alloc(0);
        let received = 0;
        let display;
        let status;
        let grpcStatus;
        let grpcMessage = '';

        const readStatus = (headers) => {
          if (headers['grpc-status'] !== undefined) {
            grpcStatus = Number(headers['grpc-status']);
            grpcMessage = decodeGrpcMessage(headers['grpc-message']);
          }
        };

        stream.on('response', (headers) => {
          headersSeen = true;
          status = Number(headers[h2.HTTP2_HEADER_STATUS]);
          if (status !== 200) {
            const code = httpToGrpc(status);
            finish(
              new AssistError(`Google answered HTTP ${status}`, 'http', {
                status,
                code,
                sent: sent && !NOT_EXECUTED.has(code),
              }),
            );
            return;
          }
          const type = String(headers[h2.HTTP2_HEADER_CONTENT_TYPE] ?? '');
          if (!type.startsWith('application/grpc')) {
            finish(
              new AssistError('Google answered something that is not gRPC', 'answer', { sent }),
            );
            return;
          }
          readStatus(headers);
        });

        stream.on('data', (chunk) => {
          if (done) return;
          received += chunk.length;
          if (received > LIMITS.answerBytes) {
            finish(
              new AssistError('The answer of Google Assistant is too large', 'answer', { sent }),
            );
            return;
          }
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          try {
            while (pending.length >= 5) {
              if (pending[0] !== 0) throw new Error('compressed frame');
              const length = pending.readUInt32BE(1);
              if (length > LIMITS.frameBytes) throw new Error('frame too large');
              if (pending.length < 5 + length) break;
              const decoded = decodeAssistResponse(pending.subarray(5, 5 + length));
              if (decoded.text) display = decoded.text;
              pending = pending.subarray(5 + length);
            }
          } catch {
            finish(
              new AssistError('The answer of Google Assistant is unreadable', 'answer', { sent }),
            );
          }
        });

        stream.on('trailers', (headers) => readStatus(headers));

        stream.on('close', () => {
          if (done) return;
          if (!headersSeen || grpcStatus === undefined || !Number.isInteger(grpcStatus)) {
            finish(
              new AssistError('The connection to Google Assistant was lost', 'lost', { sent }),
            );
            return;
          }
          if (pending.length > 0) {
            finish(new AssistError('The answer of Google Assistant is cut', 'answer', { sent }));
            return;
          }
          if (grpcStatus !== GRPC.OK) {
            finish(
              new AssistError(grpcMessage || `Google Assistant status ${grpcStatus}`, 'grpc', {
                code: grpcStatus,
                sent: sent && !NOT_EXECUTED.has(grpcStatus),
              }),
            );
            return;
          }
          finish(undefined, { text: display ? cleanText(display, LIMITS.googleText) : undefined });
        });

        stream.on('error', () => {
          finish(new AssistError('The connection to Google Assistant was lost', 'lost', { sent }));
        });

        // From here on, the request may reach Google.
        sent = true;
        stream.end(frame);
      });
    });
  }
}
