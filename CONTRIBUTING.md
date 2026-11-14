# Contributing to @bisim/voice

Thank you for helping. @bisim/voice is the voice package of Bisim's bot libraries, and contributions of every
size are welcome: a typo fix, a test, a missing option, a better error message.

## The rule that shapes everything

@bisim/voice mirrors the public surface of `@discordjs/voice`: function, class, property, event, option, enum and
status names, signatures, defaults and behaviour, so that voice code written for Discord runs on Bisim by
changing the imports. The one renaming rule: a word "Discord" in a name becomes "Bisim"
(`DiscordGatewayAdapterCreator` is `BisimGatewayAdapterCreator`). Nothing else is renamed.

Underneath, everything is Bisim's own: the adapter in bisim.js joins over Bisim's REST API, and the media goes
through LiveKit (`@livekit/rtc-node`). Read `@discordjs/voice` to match names and behaviour, then write your own
implementation. Do not copy code from it: it is under the Apache 2.0 license and this package is MIT.

## Getting started

```sh
git clone https://github.com/bisim-gg/voice.git
cd voice
npm install
npm test
```

| Script | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript, strict |
| `npm test` | the test suite (vitest), with a stand-in for LiveKit and the adapter |
| `npm run build` | ESM, CommonJS and type declarations in `dist/` |
| `npm run docs:build` | the API reference in `site/` |

The tests never reach a live voice server. To see a change working end to end, run a bot on bisim.js against a
local Bisim with `rest.api` and `ws.gateway` pointing at it, and join its voice channel from the Bisim app.

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Create a branch, make the change, and add or update tests.
3. Document every public member with TSDoc: the API reference is generated from it.
4. If the change affects how a bot is written, update the voice pages of the guide in the bisim.js repository
   (`docs/guide/voice/` and `docs/fa/guide/voice/`).
5. Add a line to `CHANGELOG.md` under an "Unreleased" heading.
6. Run `npm run typecheck`, `npm test` and `npm run build` before opening the pull request.

## Style

- TypeScript, strict, Node.js 18 or newer, no new runtime dependencies without a discussion.
- Write in plain English. Do not use the long dash or the short dash characters anywhere (code comments,
  docs, commit messages); use a comma, a colon or a full stop. A plain hyphen is fine.
- Commit messages say what a user of the library gets, in a sentence or two.

## Reporting a security problem

Please do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](./CODE_OF_CONDUCT.md).
