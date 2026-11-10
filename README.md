# gladys-google-assistant-sdk

Unofficial [Gladys Assistant](https://gladysassistant.com) integration, not affiliated with Google:
**broadcast a message on your Google speakers** (every speaker, or one room) from a Gladys scene,
through the Google Assistant API (the "Google Assistant SDK") and **your own Google Cloud project**.

- Scene action "Broadcast on Google speakers": a message (500 characters at most) and an optional room.
- "Test the connection" (a silent question to the Assistant) and "Send a test broadcast" buttons.
- OAuth 2.0 with your own OAuth client (PKCE), the refresh token kept in the Gladys configuration,
  the access token in memory only.
- One request at a time, 1 s apart, 30 per 10 minutes at most; Google's "slow down" answers pause
  every request (60 s doubled up to 6 h), a refused access is never asked again by itself.

Never tested with a real Google account or speaker; Google's Assistant API is old (`v1alpha2`) and
Gemini replaces the Assistant on part of the speakers: see the documentation.

Documentation: [English](docs/en.md) · [Français](docs/fr.md)

## Development

```bash
npm install
npm test             # node --test (fake Gladys, fake Google on loopback, virtual clock)
npm run lint
npm run format:check
npm run audit
npm run cover        # regenerates cover.png
npm run mutants      # mutation check of the guards (scripts/mutants.json), one at a time
```

Node 22 or later, ESM, no build step, one runtime dependency (`@gladysassistant/integration-sdk`).
The gRPC call is written by hand over `node:http2` (see `src/assistant.js` and `src/proto.js`).

## License

Apache-2.0 (see `LICENSE`). Third-party notices: `THIRD_PARTY_NOTICES.md`.
