// -----------------------------------------------------------------------------
// Texts: what a scene sends (message, room) and what Google answers (status
// messages), normalized and bounded. Pure functions.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

// C0 and C1 control characters, DEL, and the Unicode line/paragraph
// separators, bidirectional overrides and zero-width characters.
/* eslint-disable no-control-regex */
const CONTROLS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200f\\ufeff]',
  'g',
);
/* eslint-enable no-control-regex */

/** Printable text on one line, at most `max` characters (code points). */
export function cleanText(value, max) {
  const text = String(value ?? '')
    .replace(CONTROLS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * A message or a room name from a scene: line breaks and tabs become spaces
 * (a scene variable may carry them), runs of spaces are joined. Returns the
 * text, or an error code (`empty`, `long`, `type`); the input is never
 * echoed back.
 */
export function normalizeField(value, max, { required }) {
  if (value === undefined || value === null || value === '') {
    return required ? { error: 'empty' } : { value: '' };
  }
  if (typeof value !== 'string' && typeof value !== 'number') return { error: 'type' };
  const text = String(value).replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return required ? { error: 'empty' } : { value: '' };
  if ([...text].length > max) return { error: 'long' };
  return { value: text };
}

/** The broadcast command, in the language of the Assistant. */
export function broadcastCommand(phrases, message, room) {
  const [home, inRoom] = phrases;
  // A function replacement: `$` in the message is never a pattern.
  const fill = (template) =>
    template.replace(/\{([01])\}/g, (_, i) => (i === '0' ? message : room));
  return room ? fill(inRoom) : fill(home);
}

export const MESSAGE_MAX = LIMITS.messageChars;
export const ROOM_MAX = LIMITS.roomChars;
