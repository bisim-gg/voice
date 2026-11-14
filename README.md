# @bisim/voice

[![npm](https://img.shields.io/npm/v/@bisim/voice.svg)](https://www.npmjs.com/package/@bisim/voice)
[![CI](https://github.com/bisim-gg/voice/actions/workflows/ci.yml/badge.svg)](https://github.com/bisim-gg/voice/actions/workflows/ci.yml)

Voice for [Bisim](https://bisim.gg) bots: join voice channels, play audio and hear what others say. It is to
[bisim.js](https://github.com/bisim-gg/bisim.js) what `@discordjs/voice` is to discord.js, with the same
functions, classes, events and status names, so voice code written for Discord moves over by changing two
imports.

```diff
- const { Client } = require('discord.js');
- const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
+ const { Client } = require('bisim.js');
+ const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@bisim/voice');
```

## Install

```sh
npm install bisim.js @bisim/voice
```

Node.js 18 or newer, ESM and CommonJS, types included. Bisim's voice runs on [LiveKit](https://livekit.io), and
`@bisim/voice` brings LiveKit's Node.js SDK (with its native build for Windows, macOS and Linux) and a JavaScript
Opus codec: there are no Opus or encryption libraries to install and nothing to compile.

To play files and URLs, install [FFmpeg](https://ffmpeg.org/download.html), or `npm install ffmpeg-static`, or
set `FFMPEG_PATH`. `generateDependencyReport()` shows what was found.

## Play a file in a voice channel

```js
const { Client, Events, GatewayIntentBits } = require('bisim.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, AudioPlayerStatus, VoiceConnectionStatus } = require('@bisim/voice');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'play') return;
  const channel = interaction.member.voice.channel;
  if (!channel) return interaction.reply('Join a voice channel first.');

  const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const player = createAudioPlayer();
  connection.subscribe(player);
  player.play(createAudioResource('./song.mp3'));
  player.once(AudioPlayerStatus.Idle, () => connection.destroy());
  await interaction.reply(`Playing in ${channel.name}.`);
});

client.login(process.env.BISIM_TOKEN);
```

The bot needs View Channel, Connect and Speak in the voice channel.

## What it does

- **Connections**: `joinVoiceChannel`, `getVoiceConnection(s)`, `VoiceConnection` with `Signalling`, `Connecting`,
  `Ready`, `Disconnected` and `Destroyed`, `rejoin()`, `disconnect()`, `destroy()`, and `entersState`. A dropped
  connection joins again by itself; a moderator's move is followed; a moderator's Disconnect ends in
  `Disconnected` with close code 4014.
- **Playing**: `createAudioPlayer` and `createAudioResource` for files, URLs and streams (`StreamType.Arbitrary`,
  `OggOpus`, `WebmOpus`, `Opus` and `Raw`), `demuxProbe`, inline volume, pause, unpause and stop, and the
  `noSubscriber` and `maxMissedFrames` behaviors.
- **Receiving**: `connection.receiver.speaking` (`start`, `end`) and `receiver.subscribe(userId, { end })`, which
  gives Opus packets as on Discord (prism-media decodes them unchanged) or, with `mode: 'pcm'`, raw samples.

## How Bisim differs from Discord

A bot sends sound only (no camera, no screen), sits in one voice channel per server (joining another leaves
the first), and cannot join DM calls. A received stream leaves out quiet stretches, as on Discord. Names keep
discord.js's, except that "Discord" becomes "Bisim": `BisimGatewayAdapterCreator`, `validateBisimOpusHead`.

## Documentation

- **Guide**: [English](https://bisim-gg.github.io/bisim.js/guide/voice/) and
  [فارسی](https://bisim-gg.github.io/bisim.js/fa/guide/voice/), part of the bisim.js guide.
- **API reference**: [every class, function and option](https://bisim-gg.github.io/voice/).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) first and follow the
[code of conduct](./CODE_OF_CONDUCT.md). Report security problems privately as described in
[SECURITY.md](./SECURITY.md).

```sh
npm install
npm test             # vitest, against a stand-in for LiveKit
npm run build        # ESM, CommonJS and type declarations in dist/
npm run docs:build   # the API reference in site/
```

## License

MIT, Copyright (c) 2026-present Bisim. See [LICENSE](./LICENSE).
