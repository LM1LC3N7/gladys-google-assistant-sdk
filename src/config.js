// -----------------------------------------------------------------------------
// The configuration, normalized: the keys of the manifest `config_schema`
// (client_id, client_secret, language) and one off-schema key, refresh_token,
// written by the integration after Connect (stored by Gladys, never shown in
// the UI, never sent to the frontend). The access token is never stored: it
// lives in memory, one hour at most.
// -----------------------------------------------------------------------------

import { LANGUAGES } from './constants.js';

// Printable ASCII without spaces: what Google issues for these values. CR,
// LF and every other control character are refused (they would split a
// header or a form).
const TOKEN_LIKE = /^[\x21-\x7e]+$/;

function tokenLike(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > max || !TOKEN_LIKE.test(text)) return undefined;
  return text;
}

/**
 * -> { clientId, clientSecret, refreshToken, language, problem }. `problem`
 * is the first missing piece ('client' | 'language'), or undefined.
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const clientId = tokenLike(source.client_id, 256);
  const clientSecret = tokenLike(source.client_secret, 256);
  const refreshToken = tokenLike(source.refresh_token, 2048);
  const language = LANGUAGES.includes(source.language) ? source.language : undefined;
  let problem;
  if (!clientId || !clientSecret) problem = 'client';
  else if (!language) problem = 'language';
  return { clientId, clientSecret, refreshToken, language, problem };
}

/** The two-letter language of a Google language code (fr-FR -> fr). */
export const baseLanguage = (code) => String(code ?? 'en').split('-')[0];
