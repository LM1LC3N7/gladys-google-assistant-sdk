# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human contributors.

## What this is

A Gladys Assistant **external integration** of type `provider` (no device): a Node.js service (Node 22+,
ESM, no build step) in its own sandboxed Docker container, talking to Gladys through
`@gladysassistant/integration-sdk` (v0.16). It broadcasts a message on the user's Google speakers from a
scene action, through the Google Assistant API (gRPC `google.assistant.embedded.v1alpha2`), with the
user's own Google Cloud project and OAuth client. Unofficial: not affiliated with Google.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint && npm run format:check && npm run audit
npm run mutants                           # scripts/mutants.json, one mutant at a time (use memcap)
npm run cover                             # regenerates cover.png (800x534)
```

## Architecture

```
index.js            SDK wiring only (handlers registered before connect())
src/handlers.js     the SDK handlers + getConfig() retried at each connection (shared with the tests)
src/app.js          AssistantApp: OAuth, access token, refusal, pause, queue, broadcast, buttons
src/assistant.js    one gRPC call over node:http2 (bounded, timed out, "sent or not")
src/proto.js        the two protobuf messages, by hand (encoder, bounded decoder)
src/oauth.js        Google OAuth helpers: authorize URL (PKCE), token endpoint, Retry-After
src/store.js        /data/google-assistant.json: refusal fingerprint, pause (bounded reads)
src/config.js       config_schema keys + the off-schema refresh_token, normalized
src/text.js         message/room normalization, broadcast phrase, printable Google texts
src/i18n.js         runtime texts (en/fr)
src/constants.js    endpoints, scope, phrases, bounds, timings
test/helpers/       fake Google (token endpoint + HTTP/2 TLS Assistant), fake clock, real clock
scripts/            cover.mjs, mutants.mjs + mutants.json
```

## Rules

- **Unofficial.** Every user-facing surface says "unofficial, not affiliated with Google".
- **Secrets.** Client secret, refresh token, access token, authorization code and PKCE verifier never
  in a log, a status, `/data` or an error message. The secret field says "kept by Gladys in its
  database, never shown again, sent only to Google"; no wording that claims a cipher.
- **Refusals.** `invalid_grant` (refresh) and `invalid_client` are the only refusals; kept (memory +
  8-bit fingerprint in `/data`) and never sent again by themselves. Anything else from the token
  endpoint is not a refusal. `UNAUTHENTICATED` on a fresh access token is not a refusal.
- **Google's limits.** One request in flight, `TIMINGS.minGap` apart, `LIMITS.windowCount` per
  `LIMITS.windowMs`; a 429/5xx-like answer pauses every request to Google (`TIMINGS.pauseMin` doubled
  up to `TIMINGS.pauseMax`), kept in `/data`.
- **Budgets.** A broadcast answers within `TIMINGS.jobBudget` (the scene acks in 30 s), token renewal
  included. "Nothing sent" vs "Sent, without confirmation" follows `AssistError.sent`.
- **Clocks.** Decisions read the injected monotonic clock once; the wall clock only dates `/data`.
  Timers are injected (tests run on a virtual clock).
- **Docs.** `docs/en.md`, `docs/fr.md`, README, TODO.md, i18n and the manifest stay in line with the
  code; "never tested with a real account or speaker" until someone reports otherwise.
- Version 0.1.0 set by hand; the Release workflow owns it afterwards. `CHANGELOG.md`: `[Unreleased]`.
