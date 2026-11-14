# Changelog

All notable changes to @bisim/voice are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [0.1.0] - 2026-11-14

The first release: voice for Bisim bots, with the API of `@discordjs/voice`.

### Added

- `joinVoiceChannel`, `getVoiceConnection`, `getVoiceConnections`, `getGroups` and `VoiceConnection`, with
  `VoiceConnectionStatus`, `VoiceConnectionDisconnectReason`, `stateChange`, `error` and `debug`, `subscribe()`,
  `rejoin()`, `disconnect()`, `destroy()`, `rejoinAttempts` and `joinConfig`. Underneath, the adapter
  (`guild.voiceAdapterCreator` from bisim.js 0.2.0) joins over Bisim's API and the connection joins the channel's
  LiveKit room. A dropped connection joins again by itself, a moderator's move is followed, and a moderator's
  Disconnect ends in `Disconnected` with close code 4014.
- `createAudioPlayer` and `AudioPlayer` with `play`, `pause`, `unpause` and `stop`, `AudioPlayerStatus`,
  `NoSubscriberBehavior` and `maxMissedFrames`, `AudioPlayerError` and `PlayerSubscription`.
- `createAudioResource` and `AudioResource` for paths, URLs and streams (`StreamType` `Arbitrary`, `OggOpus`,
  `WebmOpus` and `Opus` through FFmpeg or the built-in Opus decoder, `Raw` as it is), with `inlineVolume`,
  `metadata`, `playbackDuration` and `silencePaddingFrames`.
- `demuxProbe`, `validateBisimOpusHead`, `entersState` and `generateDependencyReport`.
- `VoiceReceiver` with `speaking` (`start`, `end`) and `subscribe(userId, { end, mode })`: Opus packets by
  default, as on Discord, or raw samples with `mode: 'pcm'`; `EndBehaviorType` `Manual`, `AfterSilence` and
  `AfterInactivity`.
- The bot's speaking ring in Bisim's apps follows the player, and `selfMute` and `selfDeaf` change without
  reconnecting.
