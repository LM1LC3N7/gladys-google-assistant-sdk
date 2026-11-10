// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. (From gladys-akuvox.)
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTION, TIMINGS } from './constants.js';
import { T } from './i18n.js';

/**
 * At every (re)connection to Gladys: the configuration, then the app. A
 * configuration that cannot be read is asked again (5 s, 15 s, 30 s, then
 * every minute, without end) with a status: the integration never stays dead.
 */
export function startOnConnect(gladys, app, logger, timers = globalThis) {
  let attempt = 0;
  let timer;
  let run = 0;
  const tryStart = async (current) => {
    let config;
    try {
      config = await gladys.getConfig();
    } catch (err) {
      if (current !== run) return;
      logger?.error('Configuration not read', err?.message);
      const wait = TIMINGS.configRetry[Math.min(attempt, TIMINGS.configRetry.length - 1)];
      attempt += 1;
      gladys.setConnectionStatus(false, T.configUnreadable(wait)).catch(() => {});
      timers.clearTimeout(timer);
      timer = timers.setTimeout(() => tryStart(current), wait);
      return;
    }
    if (current !== run) return;
    attempt = 0;
    try {
      await app.start(config);
    } catch (err) {
      logger?.error('Start failed', err?.message);
    }
  };
  return {
    connected() {
      run += 1;
      timers.clearTimeout(timer);
      return tryStart(run);
    },
    stop() {
      run += 1;
      timers.clearTimeout(timer);
    },
  };
}

export function registerHandlers(gladys, app, logger, timers = globalThis) {
  gladys.onOAuthAuthorizeUrl((key, redirectUri) => app.authorizeUrl(key, redirectUri));
  gladys.onOAuthCallback((key, params) => app.oauthCallback(key, params));
  gladys.onSceneAction(SCENE_ACTION, async (fields) => {
    await app.broadcast(fields);
    return undefined;
  });
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.TEST_BROADCAST, (fields) => app.testBroadcast(fields));
  gladys.onConfigUpdated((config) => app.start(config, { saved: true }));
  const onConnect = startOnConnect(gladys, app, logger, timers);
  gladys.on('connected', () => onConnect.connected());
  return onConnect;
}
