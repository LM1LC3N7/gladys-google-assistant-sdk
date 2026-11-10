# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-10

### Added

- First version: broadcast a message on the Google speakers (every speaker or
  one room) from a scene action, through the Google Assistant API and the
  user's own Google Cloud project (OAuth 2.0 with PKCE).
- "Test the connection" (a silent question) and "Send a test broadcast"
  buttons.
- One request at a time, 1 s apart, 30 per 10 minutes at most; pauses asked by
  Google kept in `/data`; a refused access or OAuth client never asked again
  by itself (a salted 8-bit fingerprint in `/data`), lifted by Connect or new
  client credentials.

[Unreleased]: https://github.com/LM1LC3N7/gladys-google-assistant-sdk/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-google-assistant-sdk/releases/tag/v0.1.1
