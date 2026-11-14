import type { AudioPlayer } from './audio/AudioPlayer.js';
import { FRAME_MS } from './audio/pcm.js';
import type { BisimVoiceStatePayload } from './util/adapter.js';
import type { VoiceConnection } from './VoiceConnection.js';

/**
 * Where a connection is, or wants to be, and how.
 */
export interface JoinConfig {
  /** The voice channel, or `null` after a disconnect. */
  channelId: string | null;
  /** The group the connection is kept in (`'default'` unless you pass one). */
  group: string;
  /** The server. */
  guildId: string;
  /** Whether the bot is deafened (it then receives no audio). */
  selfDeaf: boolean;
  /** Whether the bot is muted (it then sends no audio). */
  selfMute: boolean;
}

/**
 * Builds the voice state request a connection hands its adapter.
 *
 * @param config - Where to be and how
 * @param connect - Ask for new connection details even for the channel the bot is in
 */
export function createJoinVoiceChannelPayload(config: JoinConfig, connect = false): BisimVoiceStatePayload {
  return {
    op: 4,
    d: {
      guild_id: config.guildId,
      channel_id: config.channelId,
      self_mute: config.selfMute,
      self_deaf: config.selfDeaf,
      ...(connect ? { connect: true } : {}),
    },
  };
}

// ---- Connections, kept per group and per server --------------------------------------------------------------

const groups = new Map<string, Map<string, VoiceConnection>>([['default', new Map()]]);

/**
 * Every group of connections, by name. Connections are in the `'default'` group unless joined with another.
 */
export function getGroups(): Map<string, Map<string, VoiceConnection>> {
  return groups;
}

/**
 * The connections of the `'default'` group, by server id.
 *
 * @param group - `'default'`
 */
export function getVoiceConnections(group?: 'default'): Map<string, VoiceConnection>;
/**
 * The connections of a group, by server id, or `undefined` for a group that was never used.
 *
 * @param group - The group
 */
export function getVoiceConnections(group: string): Map<string, VoiceConnection> | undefined;
export function getVoiceConnections(group = 'default'): Map<string, VoiceConnection> | undefined {
  return groups.get(group);
}

/**
 * The connection to a server, if there is one.
 *
 * @param guildId - The server
 * @param group - The group it was joined with, `'default'` unless you passed one
 */
export function getVoiceConnection(guildId: string, group = 'default'): VoiceConnection | undefined {
  return groups.get(group)?.get(guildId);
}

/** @internal */
export function trackVoiceConnection(connection: VoiceConnection): void {
  const { group, guildId } = connection.joinConfig;
  let map = groups.get(group);
  if (!map) {
    map = new Map();
    groups.set(group, map);
  }
  map.set(guildId, connection);
}

/** @internal */
export function untrackVoiceConnection(connection: VoiceConnection): void {
  const { group, guildId } = connection.joinConfig;
  const map = groups.get(group);
  if (map?.get(guildId) === connection) map.delete(guildId);
}

// ---- The audio clock: every playing player gets a turn every 20 ms --------------------------------------------

const players = new Set<AudioPlayer>();
let nextTick = -1;
let timer: NodeJS.Timeout | undefined;

/** If the event loop was blocked longer than this, the clock skips ahead instead of sending a burst. */
const MAX_LAG_MS = 200;

function tick(): void {
  timer = undefined;
  if (players.size === 0) {
    nextTick = -1;
    return;
  }
  const now = performance.now();
  if (now - nextTick > MAX_LAG_MS) nextTick = now - FRAME_MS;
  // Timers on some systems wake late (Windows rounds to about 15 ms), so every frame that is due is sent now.
  while (nextTick <= now) {
    for (const player of [...players]) (player as unknown as { stepFrame(): void }).stepFrame();
    nextTick += FRAME_MS;
  }
  if (players.size > 0) timer = setTimeout(tick, Math.max(1, nextTick - performance.now()));
  else nextTick = -1;
}

/**
 * Whether a player is on the audio clock.
 *
 * @internal
 */
export function hasAudioPlayer(player: AudioPlayer): boolean {
  return players.has(player);
}

/**
 * Puts a player on the audio clock.
 *
 * @internal
 */
export function addAudioPlayer(player: AudioPlayer): AudioPlayer {
  if (players.has(player)) return player;
  players.add(player);
  if (players.size === 1 && timer === undefined) {
    nextTick = performance.now();
    timer = setTimeout(tick, 0);
  }
  return player;
}

/**
 * Takes a player off the audio clock.
 *
 * @internal
 */
export function deleteAudioPlayer(player: AudioPlayer): void {
  players.delete(player);
  if (players.size === 0 && timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
    nextTick = -1;
  }
}
