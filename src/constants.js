// -----------------------------------------------------------------------------
// Fixed values: Google endpoints, the OAuth scope, the broadcast phrases, the
// bounds and the timings. Nothing here is configurable by the user.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const USER_AGENT = `gladys-google-assistant-sdk/${VERSION} (+https://github.com/LM1LC3N7/gladys-google-assistant-sdk)`;

// https://developers.google.com/identity/protocols/oauth2/web-server
export const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// The only scope the Google Assistant API accepts (the one of the official
// samples and of Home Assistant's google_assistant_sdk).
export const SCOPE = 'https://www.googleapis.com/auth/assistant-sdk-prototype';

// gRPC service of the Google Assistant SDK (protos Apache-2.0, v1alpha2).
export const ASSIST_ORIGIN = 'https://embeddedassistant.googleapis.com';
export const ASSIST_PATH = '/google.assistant.embedded.v1alpha2.EmbeddedAssistant/Assist';
// The values of the official text sample (textinput.py): no device model to
// register for a text query.
export const DEVICE_ID = 'default';
export const DEVICE_MODEL_ID = 'default';

// Languages of the Google Assistant SDK
// (https://developers.google.com/assistant/sdk/reference/rpc/languages).
export const LANGUAGES = [
  'de-DE',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-IN',
  'en-US',
  'es-ES',
  'es-MX',
  'fr-CA',
  'fr-FR',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'pt-BR',
];

// What the Assistant understands as a broadcast, per language: to the whole
// home, then to one room ({0} = the message, {1} = the room). From Google's
// help page https://support.google.com/assistant/answer/9071582, the table of
// Home Assistant's google_assistant_sdk (Apache-2.0, see THIRD_PARTY_NOTICES.md).
export const BROADCAST_PHRASES = {
  en: ['broadcast {0}', 'broadcast to {1} {0}'],
  de: ['Nachricht an alle {0}', 'Nachricht an alle an {1} {0}'],
  es: ['Anuncia {0}', 'Anuncia en {1} {0}'],
  fr: ['Diffuse {0}', 'Diffuse dans {1} {0}'],
  it: ['Trasmetti a tutti {0}', 'Trasmetti in {1} {0}'],
  ja: ['{0}とブロードキャストして', '{0}と{1}にブロードキャストして'],
  ko: ['{0} 라고 방송해 줘', '{0} 라고 {1}에 방송해 줘'],
  pt: ['Transmitir {0}', 'Transmitir {0} para {1}'],
};

// A harmless question for the "Test the connection" button: the Assistant
// answers it to the integration only (no speaker plays anything).
export const TEST_QUERIES = {
  en: 'what time is it',
  de: 'wie spät ist es',
  es: 'qué hora es',
  fr: 'quelle heure est-il',
  it: 'che ore sono',
  ja: '今何時',
  ko: '지금 몇 시야',
  pt: 'que horas são',
};

export const ACTIONS = { TEST: 'test_connection', TEST_BROADCAST: 'test_broadcast' };
export const SCENE_ACTION = 'broadcast';
export const OAUTH_KEY = 'google_account';

export const LIMITS = {
  // Characters of a message and of a room name, after normalization.
  messageChars: 500,
  roomChars: 60,
  // A token endpoint answer, a gRPC answer (all frames), one gRPC frame.
  tokenBytes: 16 * 1024,
  answerBytes: 2 * 1024 * 1024,
  frameBytes: 1024 * 1024,
  // Text kept from Google's answers (status messages, error descriptions).
  googleText: 200,
  // Broadcasts waiting behind the one in flight.
  queue: 5,
  // At most `windowCount` requests to the Assistant per `windowMs`.
  windowCount: 30,
  windowMs: 10 * 60_000,
  // OAuth states kept at once (Connect clicked several times).
  states: 5,
  // /data file.
  storeBytes: 16 * 1024,
  refusedBits: 8,
};

export const TIMINGS = {
  // The whole of one broadcast, waiting in the queue included: the scene
  // action acks within 30 s (timeout_seconds of the manifest).
  jobBudget: 25_000,
  // A request is not started with less than this left in its budget.
  minStart: 3_000,
  // One request to the Assistant, and one to the token endpoint.
  assistTimeout: 15_000,
  tokenTimeout: 10_000,
  // An access token is renewed this long before it expires.
  refreshMargin: 5 * 60_000,
  // Two requests to the Assistant are at least this far apart.
  minGap: 1_000,
  // An OAuth state is valid this long after Connect.
  stateTtl: 15 * 60_000,
  // Pause after a 429-like or 5xx-like answer: doubled each time, bounded.
  pauseMin: 60_000,
  pauseMax: 6 * 3600_000,
  // /data read within, and read again every, while unreadable.
  storeTimeout: 2_000,
  storeRetry: 10_000,
  // getConfig() failed at a (re)connection: asked again after.
  configRetry: [5_000, 15_000, 30_000, 60_000],
};
