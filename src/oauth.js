// -----------------------------------------------------------------------------
// Google OAuth 2.0 for a web server application, with the user's own OAuth
// client (https://developers.google.com/identity/protocols/oauth2/web-server):
//
// - authorization: `access_type=offline` and `prompt=consent` (Google only
//   hands a refresh token on a consent screen), the one Assistant scope, an
//   anti-CSRF `state` and PKCE S256;
// - token: `authorization_code` then `refresh_token` grants, POST form, the
//   answer read up to LIMITS.tokenBytes within TIMINGS.tokenTimeout.
//
// The redirect URI is the one Gladys hands over (its HTTPS page
// https://my.gladysassistant.com/redirect/oauth, or the instance itself): it
// is sent unchanged with the code exchange, never built here.
//
// What a refusal is, precisely (a wrong guess either hammers Google or locks
// the user out):
// - `invalid_grant` on a refresh: the refresh token is dead (revoked, 7 days
//   old while the consent screen is "In testing", 6 months unused, password
//   changed) -> `grant`;
// - `invalid_client` / `unauthorized_client`: the client ID or secret ->
//   `client`;
// - anything else (another 400, a 403, an unreadable or cut answer, a 5xx,
//   no network) is NOT a refusal: the next broadcast tries again, spaced
//   by the pause of a 429/5xx.
// No token, code, verifier or secret is ever part of an error message.
// -----------------------------------------------------------------------------

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AUTHORIZE_URL, LIMITS, SCOPE, TIMINGS, TOKEN_URL, USER_AGENT } from './constants.js';

export class TokenError extends Error {
  /**
   * kind: `grant` | `client` (refusals), `busy` (429/5xx, `retryAfter` ms),
   * `offline`, `timeout`, `answer` (anything else).
   */
  constructor(message, kind, { status, retryAfter, reason } = {}) {
    super(message);
    this.name = 'TokenError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

export const isRefusal = (err) =>
  err instanceof TokenError && (err.kind === 'grant' || err.kind === 'client');

const base64url = (buffer) => buffer.toString('base64url');

/** A fresh state and PKCE pair. */
export function createPkce() {
  const verifier = base64url(randomBytes(48));
  return {
    state: base64url(randomBytes(24)),
    verifier,
    challenge: base64url(createHash('sha256').update(verifier).digest()),
  };
}

/** Constant-time comparison of two states. */
export function sameState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, challenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/**
 * Retry-After in ms (seconds, or an HTTP date compared to the answer's own
 * Date header, never to the local clock), bounded; undefined when absent or
 * unreadable.
 */
export function parseRetryAfter(value, dateHeader) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let ms;
  if (/^\d{1,9}$/.test(value.trim())) {
    ms = Number(value.trim()) * 1000;
  } else {
    const at = Date.parse(value);
    const ref = Date.parse(dateHeader ?? '');
    if (!Number.isFinite(at) || !Number.isFinite(ref)) return undefined;
    ms = at - ref;
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, ms));
}

async function readBounded(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new TokenError('The answer of Google is too large', 'answer');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One POST to the token endpoint. Resolves the JSON answer of a 200, rejects
 * a TokenError.
 */
export async function tokenRequest(form, { tokenUrl = TOKEN_URL, timers = globalThis } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMINGS.tokenTimeout);
  try {
    let response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw timedOut
        ? new TokenError('Google did not answer in time', 'timeout')
        : new TokenError('Google is unreachable', 'offline');
    }
    let text;
    try {
      text = await readBounded(response, LIMITS.tokenBytes);
    } catch (err) {
      if (err instanceof TokenError) throw err;
      throw timedOut
        ? new TokenError('Google did not answer in time', 'timeout')
        : new TokenError('The answer of Google is cut', 'answer');
    }
    const status = response.status;
    if (status === 429 || status >= 500) {
      throw new TokenError(`Google answered HTTP ${status}`, 'busy', {
        status,
        retryAfter: parseRetryAfter(
          response.headers.get('retry-after'),
          response.headers.get('date'),
        ),
      });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (status === 200) {
      if (
        !json ||
        typeof json !== 'object' ||
        typeof json.access_token !== 'string' ||
        !json.access_token
      ) {
        throw new TokenError('Google answered without an access token', 'answer', { status });
      }
      return json;
    }
    const reason = typeof json?.error === 'string' ? json.error : undefined;
    if ((status === 400 || status === 401) && reason === 'invalid_grant') {
      throw new TokenError('Google refused the authorization', 'grant', { status, reason });
    }
    if (
      (status === 400 || status === 401) &&
      (reason === 'invalid_client' || reason === 'unauthorized_client')
    ) {
      throw new TokenError('Google refused the OAuth client ID or secret', 'client', {
        status,
        reason,
      });
    }
    throw new TokenError(`Google answered HTTP ${status}`, 'answer', { status, reason });
  } finally {
    timers.clearTimeout(timer);
  }
}

/** True when the space-separated scopes Google granted include the Assistant one. */
export function grantsAssistant(scope) {
  return String(scope ?? '')
    .split(/\s+/)
    .includes(SCOPE);
}
