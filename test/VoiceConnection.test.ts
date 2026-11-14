import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@livekit/rtc-node', () => import('./fakes/livekit.js'));

import {
  VoiceCloseCodes,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  getGroups,
  getVoiceConnection,
  getVoiceConnections,
  joinVoiceChannel,
  type VoiceConnection,
} from '../src/index.js';
import { FakeAdapter, settle } from './fakes/adapter.js';
import { DisconnectReason, FakeRoom, reset, TrackSource } from './fakes/livekit.js';

let adapter: FakeAdapter;
const opened: VoiceConnection[] = [];

function join(options: { channelId?: string; selfDeaf?: boolean; selfMute?: boolean; group?: string } = {}): VoiceConnection {
  const connection = joinVoiceChannel({ channelId: 'c1', guildId: adapter.guildId, adapterCreator: adapter.creator, ...options });
  opened.push(connection);
  return connection;
}

async function ready(connection: VoiceConnection): Promise<void> {
  await entersState(connection, VoiceConnectionStatus.Ready, 1_000);
}

beforeEach(() => {
  reset();
  adapter = new FakeAdapter();
});

afterEach(() => {
  for (const connection of opened.splice(0)) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }
});

describe('joining', () => {
  it('signals, then connects to the LiveKit room the adapter answers with, and publishes a microphone', async () => {
    const statuses: string[] = [];
    const connection = join();
    connection.on('stateChange', (_old, next) => statuses.push(next.status));
    expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
    expect(adapter.last).toEqual({ op: 4, d: { guild_id: 'g1', channel_id: 'c1', self_mute: false, self_deaf: true, connect: true } });

    await ready(connection);
    await settle();
    expect(statuses).toEqual([VoiceConnectionStatus.Connecting, VoiceConnectionStatus.Ready]);
    const room = FakeRoom.last;
    expect(room.url).toBe('wss://lk.test/c1');
    expect(room.token).toBe('token-c1');
    expect(room.options).toMatchObject({ autoSubscribe: false });
    expect(room.localParticipant!.published).toHaveLength(1);
    expect(room.localParticipant!.published[0]!.options.source).toBe(TrackSource.SOURCE_MICROPHONE);
    // Bisim's apps light the ring from what the bot announces.
    expect(room.localParticipant!.data[0]!.message).toEqual({ t: 'state', muted: false, deaf: true, speaks: true });
  });

  it('keeps connections per server and group', async () => {
    const connection = join();
    const other = join({ group: 'music' });
    expect(other).not.toBe(connection);
    expect(getVoiceConnection('g1')).toBe(connection);
    expect(getVoiceConnection('g1', 'music')).toBe(other);
    expect(getVoiceConnections()?.get('g1')).toBe(connection);
    expect(getGroups().get('music')?.get('g1')).toBe(other);
    expect(join()).toBe(connection);
  });

  it('defaults to selfDeaf true and selfMute false, like @discordjs/voice', () => {
    const connection = join();
    expect(connection.joinConfig).toEqual({ channelId: 'c1', guildId: 'g1', group: 'default', selfDeaf: true, selfMute: false });
  });

  it('goes Disconnected (EndpointRemoved) when the join is refused, and passes the error to listeners', async () => {
    adapter.autoAnswer = null;
    const connection = join();
    const errors: Error[] = [];
    connection.on('error', (error) => errors.push(error));
    adapter.server({ channel_id: 'c1', endpoint: null, error: new Error('Missing Permissions') });
    expect(connection.state).toMatchObject({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.EndpointRemoved });
    expect(errors[0]?.message).toBe('Missing Permissions');
  });

  it('goes Disconnected (AdapterUnavailable) when the adapter cannot send', () => {
    adapter.available = false;
    const connection = join();
    expect(connection.state).toMatchObject({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.AdapterUnavailable });
  });

  it('ends in Disconnected with code 1006 when LiveKit cannot be reached, and rejoin() tries again', async () => {
    adapter.autoAnswer = (channelId) => `wss://fail.test/${channelId}`;
    const connection = join();
    const errors: Error[] = [];
    connection.on('error', (error) => errors.push(error));
    await settle();
    expect(errors[0]?.message).toMatch(/could not establish/);
    expect(connection.state).toMatchObject({ reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: VoiceCloseCodes.ConnectFailed });
    adapter.autoAnswer = (channelId) => `wss://lk.test/${channelId}`;
    expect(connection.rejoin()).toBe(true);
    expect(connection.rejoinAttempts).toBe(1);
    expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
    expect(adapter.last.d.connect).toBe(true);
    await ready(connection);
    expect(connection.rejoinAttempts).toBe(0);
  });

  it('ignores connection details nobody waits for', async () => {
    adapter.autoAnswer = null;
    const connection = join();
    adapter.server({ channel_id: 'other', endpoint: 'wss://lk.test/other', token: 't' });
    expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
    adapter.server({ channel_id: 'c1', endpoint: 'wss://lk.test/c1', token: 't' });
    expect(connection.state.status).toBe(VoiceConnectionStatus.Connecting);
  });
});

describe('drops, removals and moves', () => {
  it('rejoins by itself with a fresh join when LiveKit drops a connection it could not get back', async () => {
    const connection = join();
    await ready(connection);
    const sent = adapter.payloads.length;
    FakeRoom.last.drop(DisconnectReason.SIGNAL_CLOSE);
    expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
    expect(connection.rejoinAttempts).toBe(1);
    expect(adapter.payloads).toHaveLength(sent + 1);
    expect(adapter.last.d).toMatchObject({ channel_id: 'c1', connect: true });
    await ready(connection);
    expect(connection.rejoinAttempts).toBe(0);
    expect(FakeRoom.instances).toHaveLength(2);
    expect(FakeRoom.instances[0]!.disconnected).toBe(true);
  });

  it('follows LiveKit reconnecting by itself as Connecting, then Ready', async () => {
    const connection = join();
    await ready(connection);
    FakeRoom.last.emit('reconnecting');
    expect(connection.state.status).toBe(VoiceConnectionStatus.Connecting);
    FakeRoom.last.emit('reconnected');
    expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
  });

  it("ends in Disconnected (4014) without rejoining when a moderator disconnects the bot", async () => {
    const connection = join();
    await ready(connection);
    const sent = adapter.payloads.length;
    adapter.state({ channel_id: null });
    FakeRoom.last.drop(DisconnectReason.PARTICIPANT_REMOVED);
    expect(connection.state).toMatchObject({
      status: VoiceConnectionStatus.Disconnected,
      reason: VoiceConnectionDisconnectReason.WebSocketClose,
      closeCode: 4014,
    });
    await settle();
    expect(adapter.payloads).toHaveLength(sent);
    expect(connection.joinConfig.channelId).toBe('c1');
  });

  it('ends in Disconnected (4022) when the call is ended for everyone', async () => {
    const connection = join();
    await ready(connection);
    FakeRoom.last.drop(DisconnectReason.ROOM_DELETED);
    expect(connection.state).toMatchObject({ status: VoiceConnectionStatus.Disconnected, closeCode: VoiceCloseCodes.CallTerminated });
  });

  it("follows a moderator's move: the old room's removal is part of the move, not a disconnect", async () => {
    const connection = join();
    await ready(connection);
    const oldRoom = FakeRoom.last;
    adapter.autoAnswer = null;
    // What bisim.js's adapter does on VOICE_MOVE: the new channel first, then the join's answer.
    adapter.state({ channel_id: 'c2', self_deaf: true, self_mute: false });
    oldRoom.drop(DisconnectReason.PARTICIPANT_REMOVED);
    expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
    adapter.server({ channel_id: 'c2', endpoint: 'wss://lk.test/c2', token: 'token-c2' });
    await ready(connection);
    expect(connection.joinConfig.channelId).toBe('c2');
    expect(FakeRoom.last.url).toBe('wss://lk.test/c2');
  });

  it('stays where it is when a move is refused', async () => {
    const connection = join();
    await ready(connection);
    const errors: Error[] = [];
    connection.on('error', (error) => errors.push(error));
    adapter.state({ channel_id: 'c2' });
    adapter.state({ channel_id: 'c1', error: new Error('Missing Access') });
    expect(connection.joinConfig.channelId).toBe('c1');
    expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
    expect(errors).toHaveLength(1);
    // A late answer for the refused channel changes nothing.
    adapter.server({ channel_id: 'c2', endpoint: 'wss://lk.test/c2', token: 't' });
    expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
  });

  it('moves the same connection when joinVoiceChannel names another channel of the server', async () => {
    const connection = join();
    await ready(connection);
    const oldRoom = FakeRoom.last;
    adapter.autoAnswer = null;
    expect(join({ channelId: 'c2' })).toBe(connection);
    expect(adapter.last.d).toMatchObject({ channel_id: 'c2', connect: true });
    expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
    // Bisim takes a bot out of its other channel when it joins one.
    oldRoom.drop(DisconnectReason.PARTICIPANT_REMOVED);
    expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
    adapter.server({ channel_id: 'c2', endpoint: 'wss://lk.test/c2', token: 't' });
    await ready(connection);
    expect(connection.joinConfig.channelId).toBe('c2');
  });
});

describe('own state, disconnect and destroy', () => {
  it('changes mute and deafen without reconnecting', async () => {
    const connection = join({ selfDeaf: true });
    await ready(connection);
    const room = FakeRoom.last;
    const speaker = room.addSpeaker('alice');
    await settle();
    expect(speaker.subscribed).toBe(false);
    expect(connection.rejoin({ channelId: 'c1', selfDeaf: false, selfMute: true })).toBe(true);
    expect(adapter.last).toEqual({ op: 4, d: { guild_id: 'g1', channel_id: 'c1', self_mute: true, self_deaf: false } });
    expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
    expect(FakeRoom.instances).toHaveLength(1);
    expect(speaker.subscribed).toBe(true);
    expect(room.localParticipant!.data.at(-1)!.message).toEqual({ t: 'state', muted: true, deaf: false, speaks: true });
  });

  it('sends a mute made while the join was on its way once connected', async () => {
    adapter.autoAnswer = null;
    const connection = join();
    expect(join({ selfMute: true })).toBe(connection);
    expect(adapter.payloads).toHaveLength(1);
    adapter.server({ channel_id: 'c1', endpoint: 'wss://lk.test/c1', token: 't' });
    await ready(connection);
    expect(adapter.last).toEqual({ op: 4, d: { guild_id: 'g1', channel_id: 'c1', self_mute: true, self_deaf: true } });
  });

  it("follows a moderator's server mute, publishing again once it is lifted", async () => {
    const connection = join();
    await ready(connection);
    await settle();
    const room = FakeRoom.last;
    room.emit('localTrackUnpublished', { track: undefined });
    adapter.state({ channel_id: 'c1', mute: true });
    expect(room.localParticipant!.published).toHaveLength(1);
    adapter.state({ channel_id: 'c1', mute: false });
    await settle();
    expect(room.localParticipant!.published).toHaveLength(2);
  });

  it('disconnect() leaves, ends the player subscription and ignores a late answer', async () => {
    const connection = join();
    await ready(connection);
    const player = createAudioPlayer();
    const subscription = connection.subscribe(player)!;
    expect(connection.state).toMatchObject({ subscription });
    expect(connection.disconnect()).toBe(true);
    expect(adapter.last.d).toMatchObject({ channel_id: null });
    expect(connection.state).toMatchObject({ status: VoiceConnectionStatus.Disconnected, reason: VoiceConnectionDisconnectReason.Manual });
    expect((connection.state as { subscription?: unknown }).subscription).toBeUndefined();
    expect(FakeRoom.last.disconnected).toBe(true);
    adapter.server({ channel_id: 'c1', endpoint: 'wss://lk.test/c1', token: 't' });
    expect(connection.state.status).toBe(VoiceConnectionStatus.Disconnected);
  });

  it('destroy() leaves, untracks, destroys the adapter and cannot run twice', async () => {
    const connection = join();
    await ready(connection);
    connection.destroy();
    expect(adapter.last.d).toMatchObject({ channel_id: null });
    expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
    expect(adapter.destroyed).toBe(1);
    expect(getVoiceConnection('g1')).toBeUndefined();
    expect(() => connection.destroy()).toThrow(/already destroyed/);
    expect(connection.rejoin()).toBe(false);
  });

  it("is destroyed when the adapter says it can no longer be used", async () => {
    const connection = join();
    await ready(connection);
    adapter.methods!.destroy();
    expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
  });
});
