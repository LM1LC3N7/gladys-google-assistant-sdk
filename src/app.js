// -----------------------------------------------------------------------------
// The integration: OAuth with the user's own Google Cloud client, the access
// token in memory, one request at a time to the Google Assistant API, the
// broadcast scene action and the two buttons.
//
// Rules held here (see CLAUDE.md):
// - one request to the Assistant in flight, at least TIMINGS.minGap apart, at
//   most LIMITS.windowCount per LIMITS.windowMs, LIMITS.queue waiting; every
//   broadcast answers within TIMINGS.jobBudget (the scene acks in 30 s);
// - a refusal of the refresh token or of the OAuth client is kept (memory and
//   /data fingerprint) and never sent again by itself: only Connect (a new
//   token) or changed client credentials lift it;
// - a 429/5xx-like answer pauses every request to Google (token endpoint
//   included), 60 s doubled up to 6 h, kept in /data;
// - an UNAUTHENTICATED answer to a cached access token renews it once; to a
//   fresh one it is reported, never taken for a refusal of the refresh token;
// - every decision reads the monotonic clock once; the wall clock only dates
//   /data;
// - no token, secret, code or verifier in a log, a status, /data or an error.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { AssistError, AssistantClient, GRPC } from './assistant.js';
import { baseLanguage, normalizeConfig } from './config.js';
import {
  BROADCAST_PHRASES,
  DEVICE_ID,
  DEVICE_MODEL_ID,
  LIMITS,
  OAUTH_KEY,
  TEST_QUERIES,
  TIMINGS,
  TOKEN_URL,
} from './constants.js';
import { T } from './i18n.js';
import {
  TokenError,
  buildAuthorizeUrl,
  createPkce,
  grantsAssistant,
  isRefusal,
  sameState,
  tokenRequest,
} from './oauth.js';
import { FileStore, emptyData, fingerprint } from './store.js';
import { broadcastCommand, cleanText, normalizeField } from './text.js';

/** A failure the user sees: `message` {en, fr}; the Error message is the English one. */
export class UserError extends Error {
  constructor(message) {
    super(message.en);
    this.name = 'UserError';
    this.localized = message;
  }
}

// Printable ASCII, bounded: an authorization code or a refresh token.
const REFRESH_TOKEN_SHAPE = /^[\x21-\x7e]{1,2048}$/;

const notSent = (why) => new UserError(T.notSent(why));
const unconfirmed = (why) => new UserError(T.unconfirmed(why));

export class AssistantApp {
  constructor({
    gladys,
    logger,
    store = new FileStore(),
    timers = globalThis,
    now = Date.now,
    monotonic = () => performance.now(),
    client,
    tokenUrl = TOKEN_URL,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.timers = timers;
    this.now = now;
    this.monotonic = monotonic;
    this.client = client ?? new AssistantClient({ timers });
    this.tokenUrl = tokenUrl;

    this.config = undefined;
    this.generation = 0;
    this.stopped = false;
    this.access = undefined; // { token, expires (mono), key }
    this.refreshing = undefined;
    // After a token failure that is not a refusal: no renewal before (mono).
    this.tokenRetry = { at: -Infinity, wait: 0 };
    this.processSalt = randomBytes(16).toString('hex');
    this.memRefusal = undefined; // { full, kind }
    // { until (mono), level, source: 'token' | 'assistant' }; the level is
    // reset by a success of the Assistant only (a token renewal says nothing
    // of its quota), and kept in /data across restarts.
    this.pause = undefined;
    this.pauseTimer = undefined;
    this.problem = undefined; // a status message {en, fr}, the last error
    this.data = undefined;
    this.storeState = undefined;
    this.loading = undefined;
    this.reading = undefined; // the store.load() still running, whatever the bound
    this.storeTimer = undefined;
    this.storeLogged = undefined;
    this.dirty = false;
    this.states = [];
    this.queue = [];
    this.busy = false;
    this.sentAt = []; // mono of each request to the Assistant
    this.lastSent = -Infinity;
    this.statusKey = undefined;
  }

  // --- lifecycle --------------------------------------------------------------

  /** At every (re)connection and every saved configuration. */
  async start(raw, { saved = false } = {}) {
    if (this.stopped) return;
    this.generation += 1;
    const generation = this.generation;
    const previous = this.config;
    const config = normalizeConfig(raw);
    if (
      saved &&
      !config.refreshToken &&
      previous?.refreshToken &&
      previous.clientId === config.clientId
    ) {
      // A configuration saved from the form may not carry the off-schema key.
      config.refreshToken = previous.refreshToken;
    }
    if (this.credsKey(config) !== this.credsKey(previous)) {
      // New credentials: a fresh start, no waiting on the failures of the old ones.
      this.access = undefined;
      this.tokenRetry = { at: -Infinity, wait: 0 };
    }
    this.config = config;
    this.statusKey = saved ? this.statusKey : undefined;
    if (this.data === undefined) await this.loadStore();
    if (generation !== this.generation || this.stopped) return;
    if (this.canAsk() && !this.accessValid()) {
      try {
        await this.getAccessToken();
      } catch (err) {
        this.logger?.warn('Access token not renewed', err?.message);
      }
      if (generation !== this.generation || this.stopped) return;
    }
    await this.publishStatus();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.storeTimer);
    this.timers.clearTimeout(this.pauseTimer);
    for (const job of this.queue.splice(0)) job.reject(notSent(T.stopping));
  }

  // --- /data ------------------------------------------------------------------

  /**
   * One read at a time, bounded; unreadable: read again every
   * TIMINGS.storeRetry. A read that outlives its bound (a stuck disk) still
   * counts: no other read starts before it ends, the timer only rearms.
   */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let result;
      let timer;
      if (this.reading) {
        result = { state: 'unreadable' };
      } else {
        const reading = Promise.resolve()
          .then(() => this.store.load())
          .catch(() => ({ state: 'unreadable' }));
        this.reading = reading;
        reading.finally(() => {
          if (this.reading === reading) this.reading = undefined;
        });
        result = await Promise.race([
          reading,
          new Promise((resolve) => {
            timer = this.timers.setTimeout(
              () => resolve({ state: 'unreadable' }),
              TIMINGS.storeTimeout,
            );
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
      if (this.stopped) return;
      if (result.state === 'unreadable') {
        this.storeState = 'unreadable';
        this.data ??= emptyData();
        if (this.storeLogged !== 'unreadable') {
          this.storeLogged = 'unreadable';
          this.logger?.warn('/data unreadable: kept in memory, read again later');
        }
        this.timers.clearTimeout(this.storeTimer);
        this.storeTimer = this.timers.setTimeout(() => {
          this.loadStore().then(() => this.publishStatus());
        }, TIMINGS.storeRetry);
        return;
      }
      if (this.storeLogged === 'unreadable') this.logger?.info('/data readable again');
      this.storeLogged = result.state;
      this.storeState = result.state;
      this.data = result.data;
      const mono = this.monotonic();
      const wall = this.now();
      const kept = this.data.pause;
      if (kept && kept.until > wall) {
        const until = mono + (kept.until - wall);
        if (!this.pause || until > this.pause.until) {
          this.pause = { until, level: kept.level, source: kept.source };
        }
      } else if (kept && !this.pause) {
        this.pause = { until: mono, level: kept.level, source: kept.source };
      }
      if (this.memRefusal && this.config) {
        this.data.refused = {
          fp: fingerprint(this.data.salt, this.creds(this.config)),
          kind: this.memRefusal.kind,
          at: wall,
        };
        this.dirty = true;
      }
      this.schedulePauseEnd();
      if (this.dirty) this.persist();
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** Writes the refusal and the pause, never over an unreadable file. */
  persist() {
    if (this.storeState === 'unreadable' || this.storeState === undefined) {
      this.dirty = true;
      return Promise.resolve(false);
    }
    this.dirty = false;
    const mono = this.monotonic();
    const wall = this.now();
    if (this.pause) {
      this.data.pause = {
        until: Math.round(wall + Math.max(0, this.pause.until - mono)),
        level: this.pause.level,
        source: this.pause.source,
      };
    } else {
      this.data.pause = null;
    }
    return this.store.save(this.data).then((ok) => {
      if (!ok) {
        this.dirty = true;
        this.logger?.warn('/data not written');
      }
      return ok;
    });
  }

  // --- credentials, refusal, pause ----------------------------------------------

  creds(config = this.config) {
    return {
      clientId: config?.clientId ?? '',
      clientSecret: config?.clientSecret ?? '',
      refreshToken: config?.refreshToken ?? '',
    };
  }

  /** A full HMAC under a salt of this process only: memory, never written. */
  credsKey(config = this.config) {
    const { clientId, clientSecret, refreshToken } = this.creds(config);
    return createHmac('sha256', this.processSalt)
      .update(`${clientId}\n${clientSecret}\n${refreshToken}`)
      .digest('hex');
  }

  /** 'grant' | 'client' when the current credentials were refused, else undefined. */
  refusal() {
    if (!this.config) return undefined;
    if (this.memRefusal && this.memRefusal.full === this.credsKey()) return this.memRefusal.kind;
    const kept = this.data?.refused;
    if (kept && kept.fp === fingerprint(this.data.salt, this.creds())) return kept.kind;
    return undefined;
  }

  recordRefusal(kind) {
    this.access = undefined;
    this.memRefusal = { full: this.credsKey(), kind };
    if (this.data) {
      this.data.refused = { fp: fingerprint(this.data.salt, this.creds()), kind, at: this.now() };
    }
    this.persist();
  }

  clearRefusal() {
    const had = this.memRefusal || this.data?.refused;
    this.memRefusal = undefined;
    if (this.data) this.data.refused = null;
    if (had) this.persist();
  }

  /** Remaining pause in ms (0 when none), on one read of the monotonic clock. */
  pausedFor(mono) {
    return this.pause && this.pause.until > mono ? this.pause.until - mono : 0;
  }

  recordPause(source, retryAfter) {
    const level = this.pause ? Math.min(this.pause.level + 1, 20) : 0;
    const doubled = Math.min(TIMINGS.pauseMax, TIMINGS.pauseMin * 2 ** level);
    const ms = Math.min(TIMINGS.pauseMax, Math.max(doubled, retryAfter ?? 0));
    const mono = this.monotonic();
    this.pause = { until: mono + ms, level, source };
    this.schedulePauseEnd();
    this.persist();
  }

  /** A success of the Assistant: the pause and its level are over. */
  clearPause() {
    if (!this.pause) return;
    this.pause = undefined;
    this.timers.clearTimeout(this.pauseTimer);
    this.persist();
  }

  /**
   * A success of the token endpoint: ends a pause that endpoint asked for,
   * keeps the level (only the Assistant tells about its own quota).
   */
  tokenSucceeded() {
    const mono = this.monotonic();
    if (this.pause?.source === 'token' && this.pause.until > mono) {
      this.pause = { ...this.pause, until: mono };
      this.timers.clearTimeout(this.pauseTimer);
      this.persist();
    }
  }

  /** The status is published again when the pause ends (its countdown would stay). */
  schedulePauseEnd() {
    this.timers.clearTimeout(this.pauseTimer);
    const left = this.pausedFor(this.monotonic());
    if (!left || this.stopped) return;
    this.pauseTimer = this.timers.setTimeout(() => this.pauseEnded(), left + 10);
  }

  /** At the end of a pause: the token checked again if needed, then the status. */
  async pauseEnded() {
    if (this.stopped) return;
    if (this.canAsk() && !this.accessValid()) {
      try {
        await this.getAccessToken();
      } catch (err) {
        this.logger?.warn('Access token not renewed', err?.message);
      }
    }
    await this.publishStatus();
  }

  /** True when a request to Google may be made now. */
  canAsk() {
    const c = this.config;
    return Boolean(
      c && !c.problem && c.refreshToken && !this.refusal() && !this.pausedFor(this.monotonic()),
    );
  }

  accessValid(mono = this.monotonic()) {
    return Boolean(
      this.access &&
      this.access.key === this.credsKey() &&
      mono < this.access.expires - TIMINGS.refreshMargin,
    );
  }

  // --- status -----------------------------------------------------------------

  /** The status to show: [connected, message]. */
  status() {
    const c = this.config;
    if (!c) return [false, T.notConnected];
    if (c.problem === 'client') return [false, T.missingClient];
    if (c.problem === 'language') return [false, T.missingLanguage];
    if (!c.refreshToken) return [false, T.notConnected];
    const refused = this.refusal();
    if (refused === 'grant') return [false, T.refusedGrant];
    if (refused === 'client') return [false, T.refusedClient];
    const paused = this.pausedFor(this.monotonic());
    if (paused) return [false, T.paused(paused)];
    if (this.problem) return [false, this.problem];
    return [true, T.connected];
  }

  /** One setConnectionStatus per state (forgotten at each (re)connection). */
  async publishStatus() {
    if (this.stopped) return;
    const [connected, message] = this.status();
    // The pause message carries a countdown: its key ignores the minutes.
    const key = `${connected}:${message === T.connected ? 'ok' : message.en.replace(/\d+/g, '#')}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.statusKey = undefined;
      this.logger?.warn('Status not published', err?.message);
    }
  }

  // --- access token -----------------------------------------------------------

  /**
   * -> { token, fresh }. One renewal at a time, whoever waits for it; a
   * renewal for credentials that changed meanwhile is dropped.
   */
  async getAccessToken() {
    const mono = this.monotonic();
    if (this.accessValid(mono)) return { token: this.access.token, fresh: false };
    const c = this.config;
    if (!c || c.problem === 'client') throw notSent(T.missingClient);
    if (!c.refreshToken) throw notSent(T.notConnected);
    const refused = this.refusal();
    if (refused) throw notSent(refused === 'grant' ? T.refusedGrant : T.refusedClient);
    const paused = this.pausedFor(mono);
    if (paused) throw notSent(T.paused(paused));
    if (!this.refreshing && mono < this.tokenRetry.at) throw notSent(this.problem ?? T.googleError);
    const key = this.credsKey();
    this.refreshing ??= this.refresh(c, key).finally(() => {
      this.refreshing = undefined;
    });
    const result = await this.refreshing;
    if (result.key !== this.credsKey()) throw notSent(T.notReady);
    return { token: result.token, fresh: true };
  }

  async refresh(config, key) {
    let answer;
    try {
      answer = await tokenRequest(
        {
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: config.refreshToken,
          grant_type: 'refresh_token',
        },
        { tokenUrl: this.tokenUrl, timers: this.timers },
      );
    } catch (err) {
      if (key !== this.credsKey()) throw notSent(T.notReady);
      throw this.tokenFailure(err);
    }
    if (key !== this.credsKey()) return { key };
    let current = key;
    const expiresIn = Number(answer.expires_in);
    const life = Number.isFinite(expiresIn)
      ? Math.min(24 * 3600, Math.max(60, expiresIn)) * 1000
      : 3600_000;
    const mono = this.monotonic();
    this.access = { token: answer.access_token, expires: mono + life, key };
    this.tokenRetry = { at: -Infinity, wait: 0 };
    this.clearRefusal();
    this.tokenSucceeded();
    this.problem = undefined;
    if (
      typeof answer.refresh_token === 'string' &&
      REFRESH_TOKEN_SHAPE.test(answer.refresh_token) &&
      answer.refresh_token !== config.refreshToken
    ) {
      // Google rotated the refresh token (rare): kept, or the next start fails.
      try {
        await this.saveRefreshToken(answer.refresh_token);
        current = this.credsKey();
      } catch {
        this.logger?.warn('Rotated refresh token not saved');
      }
    }
    return { key: current, token: answer.access_token };
  }

  /** A TokenError as the UserError to throw, with its effect (refusal, pause, problem). */
  tokenFailure(err) {
    if (!isRefusal(err) && !(err instanceof UserError)) {
      // Not a refusal: the next renewal waits 5 s, doubled up to 1 h.
      const wait = Math.min(3600_000, Math.max(5_000, this.tokenRetry.wait * 2));
      this.tokenRetry = { at: this.monotonic() + wait, wait };
    }
    if (isRefusal(err)) {
      this.recordRefusal(err.kind);
      this.publishStatus();
      return notSent(err.kind === 'grant' ? T.refusedGrant : T.refusedClient);
    }
    if (err instanceof TokenError && err.kind === 'busy') {
      this.recordPause('token', err.retryAfter);
      this.publishStatus();
      return notSent(err.status === 429 ? T.quota : T.googleServer);
    }
    if (err instanceof TokenError && (err.kind === 'offline' || err.kind === 'timeout')) {
      this.problem = T.unreachable;
      this.publishStatus();
      return notSent(T.unreachable);
    }
    if (err instanceof UserError) return err;
    this.problem = T.googleError;
    this.publishStatus();
    return notSent(T.googleError);
  }

  async saveRefreshToken(refreshToken) {
    await this.gladys.setConfig({ refresh_token: refreshToken });
    if (this.config) this.config = { ...this.config, refreshToken };
    if (this.access) this.access = { ...this.access, key: this.credsKey() };
  }

  // --- OAuth ------------------------------------------------------------------

  authorizeUrl(key, redirectUri) {
    if (key !== OAUTH_KEY) throw new UserError(T.unknownKey);
    const c = this.config;
    if (!c || c.problem === 'client') throw new UserError(T.missingClient);
    if (!validRedirect(redirectUri)) throw new UserError(T.badRedirect);
    const mono = this.monotonic();
    const paused = this.pausedFor(mono);
    // Refused before the consent screen, not after it.
    if (paused) throw new UserError(T.paused(paused));
    const { state, verifier, challenge } = createPkce();
    this.states = this.states.filter((s) => s.expires > mono).slice(-(LIMITS.states - 1));
    this.states.push({
      state,
      verifier,
      redirectUri,
      clientId: c.clientId,
      expires: mono + TIMINGS.stateTtl,
    });
    return buildAuthorizeUrl({ clientId: c.clientId, redirectUri, state, challenge });
  }

  async oauthCallback(key, { code, state, redirectUri } = {}) {
    if (key !== OAUTH_KEY) throw new UserError(T.unknownKey);
    const mono = this.monotonic();
    const index = this.states.findIndex((s) => s.expires > mono && sameState(s.state, state));
    if (index < 0) throw new UserError(T.badState);
    const [entry] = this.states.splice(index, 1);
    if (redirectUri !== entry.redirectUri) throw new UserError(T.badRedirect);
    if (typeof code !== 'string' || !REFRESH_TOKEN_SHAPE.test(code)) {
      throw new UserError(T.codeRefused);
    }
    const c = this.config;
    if (!c || c.problem === 'client') throw new UserError(T.missingClient);
    if (c.clientId !== entry.clientId) throw new UserError(T.clientChanged);
    const paused = this.pausedFor(mono);
    if (paused) throw new UserError(T.paused(paused));
    let answer;
    try {
      answer = await tokenRequest(
        {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code,
          code_verifier: entry.verifier,
          grant_type: 'authorization_code',
          redirect_uri: entry.redirectUri,
        },
        { tokenUrl: this.tokenUrl, timers: this.timers },
      );
    } catch (err) {
      if (err instanceof TokenError && err.kind === 'grant') throw new UserError(T.codeRefused);
      if (err instanceof TokenError && err.kind === 'client') {
        this.problem = T.refusedClient;
        await this.publishStatus();
        throw new UserError(T.refusedClient);
      }
      throw new UserError(this.tokenFailure(err).localized);
    }
    if (
      typeof answer.refresh_token !== 'string' ||
      !REFRESH_TOKEN_SHAPE.test(answer.refresh_token)
    ) {
      throw new UserError(T.noRefreshToken);
    }
    if (answer.scope !== undefined && !grantsAssistant(answer.scope)) {
      throw new UserError(T.scopeMissing);
    }
    try {
      await this.gladys.setConfig({ refresh_token: answer.refresh_token });
    } catch {
      throw new UserError(T.saveFailed);
    }
    if (c !== this.config && this.config?.clientId !== c.clientId) {
      throw new UserError(T.clientChanged);
    }
    this.config = { ...this.config, refreshToken: answer.refresh_token };
    const expiresIn = Number(answer.expires_in);
    const life = Number.isFinite(expiresIn)
      ? Math.min(24 * 3600, Math.max(60, expiresIn)) * 1000
      : 3600_000;
    this.access = {
      token: answer.access_token,
      expires: this.monotonic() + life,
      key: this.credsKey(),
    };
    this.tokenRetry = { at: -Infinity, wait: 0 };
    this.clearRefusal();
    this.tokenSucceeded();
    this.problem = undefined;
    await this.publishStatus();
  }

  // --- requests to the Assistant -----------------------------------------------

  /** The scene action: broadcast a message to every speaker, or to one room. */
  async broadcast(fields = {}) {
    const message = normalizeField(fields.message, LIMITS.messageChars, { required: true });
    if (message.error) {
      throw notSent(
        message.error === 'long'
          ? T.longMessage
          : message.error === 'type'
            ? T.badType
            : T.emptyMessage,
      );
    }
    const room = normalizeField(fields.room, LIMITS.roomChars, { required: false });
    if (room.error) throw notSent(room.error === 'type' ? T.badType : T.badRoom);
    return this.enqueue((language) => {
      const phrases = BROADCAST_PHRASES[baseLanguage(language)] ?? BROADCAST_PHRASES.en;
      return broadcastCommand(phrases, message.value, room.value);
    });
  }

  /** "Test the connection": a harmless question, no speaker plays anything. */
  async testConnection() {
    try {
      const { text } = await this.enqueue(
        (language) => TEST_QUERIES[baseLanguage(language)] ?? TEST_QUERIES.en,
      );
      return T.testOk(text);
    } catch (err) {
      if (err instanceof UserError) return err.localized;
      throw err;
    }
  }

  /** "Send a test broadcast": the scene action from the Configuration screen. */
  async testBroadcast(fields) {
    try {
      await this.broadcast(fields);
      return T.accepted;
    } catch (err) {
      if (err instanceof UserError) return err.localized;
      throw err;
    }
  }

  /** Queues one request; the job answers within TIMINGS.jobBudget. */
  enqueue(command) {
    if (this.stopped) return Promise.reject(notSent(T.stopping));
    if (!this.config || this.storeState === undefined) return Promise.reject(notSent(T.notReady));
    const early = this.blocker(this.monotonic());
    if (early) return Promise.reject(notSent(early));
    if (this.queue.length >= LIMITS.queue) return Promise.reject(notSent(T.queueFull));
    return new Promise((resolve, reject) => {
      this.queue.push({ command, deadline: this.monotonic() + TIMINGS.jobBudget, resolve, reject });
      this.drain();
    });
  }

  /** What stops a request now (a reason), or undefined. */
  blocker(mono) {
    const c = this.config;
    if (!c) return T.notReady;
    if (c.problem === 'client') return T.missingClient;
    if (c.problem === 'language') return T.missingLanguage;
    if (!c.refreshToken) return T.notConnected;
    const refused = this.refusal();
    if (refused) return refused === 'grant' ? T.refusedGrant : T.refusedClient;
    const paused = this.pausedFor(mono);
    if (paused) return T.paused(paused);
    return undefined;
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift();
        try {
          job.resolve(await this.run(job));
        } catch (err) {
          job.reject(err instanceof UserError ? err : notSent(T.googleError));
        }
        // Not awaited: a slow Gladys API never eats the budget of the next one.
        this.publishStatus();
      }
    } finally {
      this.busy = false;
    }
  }

  /** Waits (injected timers) until the minimum gap since the last request. */
  async spacing(job) {
    // A timer may fire a fraction of a millisecond early: measured again.
    for (let i = 0; i < 100; i += 1) {
      const mono = this.monotonic();
      const wait = this.lastSent + TIMINGS.minGap - mono;
      if (wait <= 0) return;
      if (mono + wait > job.deadline - TIMINGS.minStart) throw notSent(T.tooLate);
      await new Promise((resolve) => this.timers.setTimeout(resolve, Math.max(1, wait)));
    }
    throw notSent(T.tooLate);
  }

  windowFull(mono) {
    this.sentAt = this.sentAt.filter((at) => at > mono - LIMITS.windowMs);
    return this.sentAt.length >= LIMITS.windowCount;
  }

  /** One slot of the window, taken at the decision to send; false when full. */
  takeSlot(mono) {
    if (this.windowFull(mono)) return false;
    this.sentAt.push(mono);
    this.lastSent = mono;
    return true;
  }

  /** What is left of the budget of a job (ms); too little to start a request: not sent. */
  budget(job, mono) {
    const left = job.deadline - mono;
    if (left < TIMINGS.minStart) throw notSent(T.tooLate);
    return left;
  }

  /**
   * The access token, within the budget of the job: a renewal still running
   * at the deadline goes on for the next request, this one is not sent.
   */
  async tokenWithin(job) {
    const left = this.budget(job, this.monotonic());
    let timer;
    try {
      return await Promise.race([
        this.getAccessToken(),
        new Promise((_, reject) => {
          timer = this.timers.setTimeout(
            () => reject(notSent(T.unreachable)),
            left - TIMINGS.minStart,
          );
        }),
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  async run(job) {
    await this.spacing(job);
    if (this.stopped) throw notSent(T.stopping);
    if (this.windowFull(this.monotonic())) throw notSent(T.tooMany);
    let auth = await this.tokenWithin(job);
    for (let attempt = 0; ; attempt += 1) {
      const mono = this.monotonic();
      if (this.stopped) throw notSent(T.stopping);
      const blocked = this.blocker(mono);
      if (blocked) throw notSent(blocked);
      const left = this.budget(job, mono);
      if (!this.takeSlot(mono)) throw notSent(T.tooMany);
      const language = this.config.language;
      try {
        const result = await this.client.assist({
          text: job.command(language),
          languageCode: language,
          accessToken: auth.token,
          deviceId: DEVICE_ID,
          deviceModelId: DEVICE_MODEL_ID,
          timeout: Math.min(TIMINGS.assistTimeout, left - 500),
        });
        this.problem = undefined;
        this.clearPause();
        return result;
      } catch (err) {
        if (!(err instanceof AssistError)) throw err;
        if (err.code === GRPC.UNAUTHENTICATED) {
          if (!auth.fresh && attempt === 0) {
            // The cached token expired or was revoked early: renewed once.
            this.access = undefined;
            auth = await this.tokenWithin(job);
            continue;
          }
          this.access = undefined;
          this.problem = T.tokenRejected;
          throw notSent(T.tokenRejected);
        }
        throw this.assistFailure(err);
      }
    }
  }

  /** An AssistError as the UserError to throw, with its effect (pause, problem). */
  assistFailure(err) {
    const wrap = (why) => (err.sent ? unconfirmed(why) : notSent(why));
    if (err.code === GRPC.RESOURCE_EXHAUSTED) {
      this.recordPause('assistant');
      return wrap(T.quota);
    }
    if (
      err.code === GRPC.UNAVAILABLE ||
      err.code === GRPC.INTERNAL ||
      (err.kind === 'http' && err.status >= 500)
    ) {
      this.recordPause('assistant');
      return wrap(T.serverError);
    }
    if (err.code === GRPC.PERMISSION_DENIED) {
      const detail = err.kind === 'grpc' ? cleanText(err.message, 120) : '';
      this.problem = T.denied(detail);
      return wrap(this.problem);
    }
    if (err.kind === 'offline') {
      this.problem = T.unreachable;
      return notSent(T.unreachable);
    }
    if (err.kind === 'timeout') return wrap(T.timeout);
    if (err.kind === 'lost') return wrap(T.lost);
    if (err.kind === 'answer') return wrap(T.badAnswer);
    this.problem = T.googleError;
    return wrap(T.googleError);
  }
}

/** The redirect URI handed by Gladys: an absolute http(s) URL, printable, bounded. */
function validRedirect(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
