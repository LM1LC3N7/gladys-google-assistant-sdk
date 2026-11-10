# TODO

## Decisions

- 2026-11-10 — Version 0.1.0 set by hand (package.json, lock, manifest, docker_image); the Release workflow
  owns it from now on. SDK `^0.16.0` (latest published on 2026-11-10, CHANGELOG read). Gladys 5.3.2,
  `gladys_version: ">=5.1.0"` (scene actions, `provider` type).
- API checked on 2026-11-10 before any code: `embeddedassistant.googleapis.com` answers gRPC
  (`UNAUTHENTICATED` to an invalid token, "unregistered callers" without one). Not checked: that a
  broadcast is still played by speakers moved to Gemini (Google acknowledged a Gemini broadcast bug in
  2026). Said in the docs.
- Reference: gassist_text 0.1.0 (tronikos, Apache-2.0, commit 29677af, a copy of Google's
  `textinput.py` sample, Apache-2.0) and the `embedded_assistant.proto` field numbers (Google,
  Apache-2.0); broadcast phrases and language list from Home Assistant's `google_assistant_sdk`
  (Apache-2.0, `notify.py` 0b7e2fa). Licenses read on 2026-11-10. Nothing copied or installed: the two
  messages are encoded by hand (`src/proto.js`), the call goes over `node:http2` (`src/assistant.js`);
  no `@grpc/grpc-js`/`protobufjs` (memory, a 2-field need).
- Manifest `type: "provider"` (no device): one scene action `broadcast` (message, room), two actions
  `test_connection` (silent "what time is it", nothing played) and `test_broadcast`. Categories
  `notifications`, `assistants`; `transports: ["cloud"]`. No `keywords`, no `countries` (worldwide).
- OAuth: the user's own client (Web application), redirect URI handed by Gladys (never built), PKCE
  S256, `access_type=offline`, `prompt=consent`, the single scope `assistant-sdk-prototype` (checked in
  the answer). States: 5 at most, 15 min, single use, constant-time compare, redirect URI byte for byte.
  The refresh token goes to an off-schema config key (`refresh_token`) through `setConfig`; the access
  token stays in memory. Docs: publish the consent screen "In production" (7-day expiry in testing),
  or add the account as a test user.
- Refusals: `invalid_grant` on a refresh = refused account, `invalid_client`/`unauthorized_client` =
  refused client; kept in memory and as an 8-bit salted fingerprint of (client ID, secret, refresh
  token) in `/data`, never sent again by itself (not by a broadcast, not by a button), lifted by
  Connect or changed credentials. Not refusals: other 400, 403, unreadable/cut/huge answers, no network
  (renewal spaced 5 s doubled to 1 h); `invalid_grant` on a code exchange (the code, not the account).
- gRPC `UNAUTHENTICATED`: on a cached access token, renewed once and sent again; on a fresh one,
  reported ("did not accept a fresh access token"), never a refusal of the refresh token.
- Pauses: `RESOURCE_EXHAUSTED`, HTTP 429, `UNAVAILABLE`, `INTERNAL`, 5xx (Assistant and token
  endpoint): every request to Google paused 60 s doubled up to 6 h (or a longer `Retry-After` of the token endpoint, read
  against the answer's `Date`), kept in `/data` with its level and source, a pause ending beyond 6 h from now is dropped. The
  level is reset by a success of the Assistant only (review r1, I1); a token success ends a pause the
  token endpoint set, keeping the level. A timer republishes the status at the end of a pause (rearmed if it fires early), after one renewal
  of an expired access token (review r2, N2, N4).
- `/data` read one at a time even past its 2 s bound (review r1, I2): a stuck read blocks any new one,
  the retry timer only rearms. `FileStore` itself follows the disk operation, not its 2 s bound: no new
  open while one is still running (review r2, I2).
- Sent or not: "Nothing sent" when the request did not leave or Google said it did not run it (gRPC 3,
  5, 7, 8, 9, 12, 16, HTTP 429); otherwise "Sent, without confirmation". "Accepted" only on gRPC OK.
- Bounds: message 500 characters and room 60 (one line, controls removed, never echoed back), answer
  2 MB and frame 1 MB cut before full reception, token answer 16 KB, one request in flight, 1 s apart,
  30 per 10 min, 5 waiting, each broadcast answered within 25 s (scene ack 30 s), Assistant call 15 s,
  token call 10 s.
- `/data`: read bounded (2 s, 16 KB, regular file, no symbolic link), read again every 10 s while
  unreadable, never overwritten while unreadable; nothing waits on it beyond the 2 s at start.
- Not a notification channel (`communication` type) in v1: a per-user channel would broadcast once per
  user to the same speakers.

## Later

- A second scene action "Send a command to Google Assistant" (free text, like Home Assistant's
  `send_text_command`), if users ask for it.
- Playing the Assistant's audio answer on a Gladys speaker.
- A revoke button (`https://oauth2.googleapis.com/revoke`).
