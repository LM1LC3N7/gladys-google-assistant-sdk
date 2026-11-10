// -----------------------------------------------------------------------------
// Connect: the authorization URL, then the callback (state, PKCE, redirect
// URI byte for byte, refresh token saved off-schema) through the fake Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SCOPE, TIMINGS } from '../src/constants.js';
import { ACCESS_TOKEN, CLIENT_ID, NEW_REFRESH_TOKEN, SECRETS } from './helpers/fakeGoogle.js';
import { REDIRECT, broadcast, fullConfig, setup, statuses, until, within } from './helpers/app.js';

const authorize = async (gladys, redirect = REDIRECT) => {
  const ack = await within(gladys.fake.oauthAuthorizeUrl('google_account', redirect), 3000, 'url');
  assert.equal(ack.success, true, ack.error);
  const url = new URL(ack.data.authorize_url);
  return { url, params: Object.fromEntries(url.searchParams) };
};

const callback = (gladys, params) =>
  within(gladys.fake.oauthCallback('google_account', params), 5000, 'callback');

test('the authorization URL: Google, offline, consent, the one scope, state and PKCE S256', async (t) => {
  const ctx = await setup(t, { config: fullConfig({ refresh_token: undefined }) });
  const { url, params } = await authorize(ctx.gladys);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(params.client_id, CLIENT_ID);
  assert.equal(params.redirect_uri, REDIRECT);
  assert.equal(params.response_type, 'code');
  assert.equal(params.scope, SCOPE);
  assert.equal(params.access_type, 'offline');
  assert.equal(params.prompt, 'consent');
  assert.equal(params.code_challenge_method, 'S256');
  assert.match(params.state, /^[\w-]{32}$/);
  assert.match(params.code_challenge, /^[\w-]{43}$/);
  assert.ok(!url.toString().includes('GOCSPX'), 'never the secret');
});

test('Connect without the client fields, with another key or a bad redirect: refused', async (t) => {
  const ctx = await setup(t, { config: fullConfig({ client_id: '', refresh_token: undefined }) });
  let ack = await within(
    ctx.gladys.fake.oauthAuthorizeUrl('google_account', REDIRECT),
    3000,
    'url',
  );
  assert.equal(ack.success, false);
  assert.match(ack.error, /client ID and the client secret/);
  const other = await setup(t, { config: fullConfig({ refresh_token: undefined }) });
  ack = await within(other.gladys.fake.oauthAuthorizeUrl('other', REDIRECT), 3000, 'url');
  assert.equal(ack.success, false);
  for (const bad of ['javascript:alert(1)', 'https://x/\r\nSet-Cookie: a', '', 'not a url']) {
    ack = await within(other.gladys.fake.oauthAuthorizeUrl('google_account', bad), 3000, 'url');
    assert.equal(ack.success, false, bad);
  }
});

test('the callback: code + verifier + same redirect, refresh token saved, linked, usable', async (t) => {
  const ctx = await setup(t, { config: fullConfig({ refresh_token: undefined }) });
  const { params } = await authorize(ctx.gladys);
  const ack = await callback(ctx.gladys, {
    code: '4/code-xyz',
    state: params.state,
    redirectUri: REDIRECT,
  });
  assert.equal(ack.success, true, ack.error);
  const [request] = ctx.token.requests;
  assert.equal(request.form.grant_type, 'authorization_code');
  assert.equal(request.form.code, '4/code-xyz');
  assert.equal(request.form.redirect_uri, REDIRECT);
  assert.equal(
    createHash('sha256').update(request.form.code_verifier).digest('base64url'),
    params.code_challenge,
  );
  assert.equal(ctx.gladys.fake.config.refresh_token, NEW_REFRESH_TOKEN);
  assert.deepEqual(statuses(ctx.gladys).at(-1), [true, 'Google account linked.']);
  // The access token of the exchange is used: no renewal before the broadcast.
  const sent = await broadcast(ctx.gladys, { message: 'hello' });
  assert.equal(sent.success, true, sent.error);
  assert.equal(ctx.token.count('refresh_token'), 0);
  assert.equal(ctx.google.calls[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  for (const secret of SECRETS) {
    for (const line of ctx.lines) assert.ok(!line.includes(secret), line);
  }
});

test('the state: unknown, reused or expired is refused before any request to Google', async (t) => {
  const ctx = await setup(t, { config: fullConfig({ refresh_token: undefined }) });
  const { params } = await authorize(ctx.gladys);
  let ack = await callback(ctx.gladys, { code: 'c', state: 'forged', redirectUri: REDIRECT });
  assert.match(ack.error, /unknown or expired/);
  ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.equal(ack.success, true, ack.error);
  ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.match(ack.error, /unknown or expired/, 'single use');
  const second = await authorize(ctx.gladys);
  await ctx.step(TIMINGS.stateTtl + 1);
  ack = await callback(ctx.gladys, {
    code: 'c',
    state: second.params.state,
    redirectUri: REDIRECT,
  });
  assert.match(ack.error, /unknown or expired/);
  assert.equal(ctx.token.count('authorization_code'), 1);
});

test('five Connect clicks: the last five states stay valid, older ones drop', async (t) => {
  const ctx = await setup(t, { config: fullConfig({ refresh_token: undefined }) });
  const states = [];
  for (let i = 0; i < 6; i += 1) states.push((await authorize(ctx.gladys)).params.state);
  let ack = await callback(ctx.gladys, { code: 'c', state: states[0], redirectUri: REDIRECT });
  assert.match(ack.error, /unknown or expired/);
  ack = await callback(ctx.gladys, { code: 'c', state: states[5], redirectUri: REDIRECT });
  assert.equal(ack.success, true, ack.error);
});

test('another redirect URI at the callback: refused', async (t) => {
  const ctx = await setup(t, { config: fullConfig({ refresh_token: undefined }) });
  const { params } = await authorize(ctx.gladys);
  const ack = await callback(ctx.gladys, {
    code: 'c',
    state: params.state,
    redirectUri: `${REDIRECT}/`,
  });
  assert.match(ack.error, /redirect address changed/);
  assert.equal(ctx.token.count(), 0);
});

test('Google answers without refresh token, or without the scope: refused, nothing saved', async (t) => {
  const ctx = await setup(t, { config: fullConfig({ refresh_token: undefined }) });
  ctx.token.reply = (req, form, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3599, scope: SCOPE }));
  };
  let { params } = await authorize(ctx.gladys);
  let ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.match(ack.error, /did not hand a refresh token/);
  ctx.token.reply = (req, form, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: ACCESS_TOKEN,
        refresh_token: NEW_REFRESH_TOKEN,
        scope: 'openid email',
      }),
    );
  };
  ({ params } = await authorize(ctx.gladys));
  ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.match(ack.error, /permission was not granted/);
  assert.equal(ctx.gladys.fake.config.refresh_token, undefined);
});

test('a refused code is not a refusal of the account; invalid_client is reported', async (t) => {
  const ctx = await setup(t);
  ctx.token.mode = 'invalid_grant';
  let { params } = await authorize(ctx.gladys);
  let ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.match(ack.error, /authorization code \(expired or already used\)/);
  assert.equal(ctx.app.refusal(), undefined);
  assert.equal(ctx.store.data.refused, null);
  ctx.token.mode = 'invalid_client';
  ({ params } = await authorize(ctx.gladys));
  ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.match(ack.error, /refused the client ID/);
  assert.match(statuses(ctx.gladys).at(-1)[1], /refused the client ID/);
});

test('Connect during a pause: refused at the authorization URL, before the consent screen', async (t) => {
  const ctx = await setup(t, { token: '503' });
  const ack = await within(
    ctx.gladys.fake.oauthAuthorizeUrl('google_account', REDIRECT),
    3000,
    'url',
  );
  assert.equal(ack.success, false);
  assert.match(ack.error, /slow down/);
  assert.equal(ctx.app.states.length, 0);
  assert.equal(ctx.token.count('authorization_code'), 0);
});

test('a pause that starts between Connect and the callback: refused without asking Google', async (t) => {
  const ctx = await setup(t);
  const { params } = await authorize(ctx.gladys);
  ctx.app.recordPause('assistant');
  const ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.match(ack.error, /slow down/);
  assert.equal(ctx.token.count('authorization_code'), 0);
});

test('Connect lifts a refusal; a failed save of the token is said, not hidden', async (t) => {
  const ctx = await setup(t, { token: 'invalid_grant' });
  assert.equal(ctx.app.refusal(), 'grant');
  ctx.token.mode = 'ok';
  let { params } = await authorize(ctx.gladys);
  let ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.app.refusal(), undefined);
  await until(() => ctx.store.data.refused === null);

  const original = ctx.gladys.setConfig.bind(ctx.gladys);
  ctx.gladys.setConfig = async () => {
    throw new Error('host API down');
  };
  t.after(() => (ctx.gladys.setConfig = original));
  ({ params } = await authorize(ctx.gladys));
  ack = await callback(ctx.gladys, { code: 'c', state: params.state, redirectUri: REDIRECT });
  assert.match(ack.error, /could not save the Google authorization/);
});
