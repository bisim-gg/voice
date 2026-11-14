import type { JoinConfig } from './DataStore.js';
import { createVoiceConnection, type CreateVoiceConnectionOptions, type VoiceConnection } from './VoiceConnection.js';

/**
 * Where to join, for {@link joinVoiceChannel}.
 */
export interface JoinVoiceChannelOptions {
  /** The voice channel. */
  channelId: string;
  /** The server it belongs to. */
  guildId: string;
  /** Keep this connection in a group of your own, so one server can have a connection per group. Default `'default'`. */
  group?: string;
  /** Join deafened: the bot then receives nobody's audio. Default `true`. */
  selfDeaf?: boolean;
  /** Join muted: the bot then sends no audio. Default `false`. */
  selfMute?: boolean;
}

/**
 * Joins a voice channel, or moves the server's existing connection to it.
 *
 * On Bisim a bot sends sound only, sits in one voice channel per server (joining another leaves the first), and
 * cannot join a DM call.
 *
 * @example
 * ```js
 * const { joinVoiceChannel } = require('@bisim/voice');
 *
 * const connection = joinVoiceChannel({
 *   channelId: channel.id,
 *   guildId: channel.guild.id,
 *   adapterCreator: channel.guild.voiceAdapterCreator,
 * });
 * ```
 * @param options - Where and how to join
 * @returns The connection
 */
export function joinVoiceChannel(options: CreateVoiceConnectionOptions & JoinVoiceChannelOptions): VoiceConnection {
  const { channelId, guildId, group = 'default', selfDeaf = true, selfMute = false } = options;
  const { adapterCreator, debug, daveEncryption, decryptionFailureTolerance } = options;
  const config: JoinConfig = { channelId, guildId, group, selfDeaf, selfMute };
  return createVoiceConnection(config, { adapterCreator, debug, daveEncryption, decryptionFailureTolerance });
}
