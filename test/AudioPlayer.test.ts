import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@livekit/rtc-node', () => import('./fakes/livekit.js'));

import {
  AudioPlayerError,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '../src/index.js';
import { FakeAdapter, settle } from './fakes/adapter.js';
import { AudioSource, FakeRoom, reset } from './fakes/livekit.js';

const FRAME = 3840;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `count` frames, frame i filled with the sample value i + 1. */
function numbered(count: number): Buffer {
  const buffer = Buffer.alloc(count * FRAME);
  for (let i = 0; i < count; i++) for (let o = 0; o < FRAME; o += 2) buffer.writeInt16LE(i + 1, i * FRAME + o);
  return buffer;
}

function endless(value = 1000): Readable {
  return new Readable({
    read() {
      this.push(Buffer.alloc(FRAME, 0).fill(Buffer.from([value & 0xff, value >> 8])));
    },
  });
}

const firstSamples = () => AudioSource.instances.at(-1)!.frames.map((frame) => frame.data[0]);

let connection: VoiceConnection;
let player: AudioPlayer;

async function connect(): Promise<VoiceConnection> {
  const adapter = new FakeAdapter();
  connection = joinVoiceChannel({ channelId: 'c1', guildId: 'g1', adapterCreator: adapter.creator });
  await entersState(connection, VoiceConnectionStatus.Ready, 1_000);
  await settle();
  return connection;
}

beforeEach(() => {
  reset();
});

afterEach(() => {
  player?.stop(true);
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
});

describe('AudioPlayer', () => {
  it('buffers, plays every frame in order, pads with silence and goes idle', async () => {
    await connect();
    player = createAudioPlayer();
    connection.subscribe(player);
    const statuses: string[] = [];
    player.on('stateChange', (_old, next) => statuses.push(next.status));
    const resource = createAudioResource(Readable.from([numbered(10)]), { inputType: StreamType.Raw, metadata: { title: 'ten frames' } });
    expect(resource.metadata).toEqual({ title: 'ten frames' });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Idle, 2_000);
    expect(statuses[0]).toBe(AudioPlayerStatus.Buffering);
    expect(statuses).toContain(AudioPlayerStatus.Playing);
    expect(firstSamples()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 0, 0, 0, 0]);
    expect(resource.playbackDuration).toBe(200);
    expect(resource.ended).toBe(true);
    const announced = FakeRoom.last.localParticipant!.data.map((entry) => entry.message).filter((message) => message.t === 'speaking');
    expect(announced).toEqual([
      { t: 'speaking', on: true },
      { t: 'speaking', on: false },
    ]);
  });

  it('keeps pace with the clock: about 50 frames a second', async () => {
    await connect();
    player = createAudioPlayer();
    connection.subscribe(player);
    player.play(createAudioResource(endless(), { inputType: StreamType.Raw }));
    await sleep(1_000);
    const sent = AudioSource.instances.at(-1)!.frames.length;
    expect(sent).toBeGreaterThanOrEqual(44);
    expect(sent).toBeLessThanOrEqual(58);
  });

  it('pauses with a few frames of silence and carries on after unpause', async () => {
    await connect();
    player = createAudioPlayer();
    connection.subscribe(player);
    player.play(createAudioResource(endless(1000), { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Playing, 1_000);
    await sleep(100);
    expect(player.pause()).toBe(true);
    expect(player.pause()).toBe(false);
    await sleep(200);
    const atPause = firstSamples();
    expect(atPause.slice(-5)).toEqual([0, 0, 0, 0, 0]);
    await sleep(100);
    expect(firstSamples()).toHaveLength(atPause.length);
    expect(player.unpause()).toBe(true);
    await sleep(100);
    expect(firstSamples().at(-1)).toBe(1000);
  });

  it('pauses itself while no connection is ready, and plays again once one is', async () => {
    player = createAudioPlayer();
    player.play(createAudioResource(endless(), { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.AutoPaused, 1_000);
    await connect();
    connection.subscribe(player);
    await entersState(player, AudioPlayerStatus.Playing, 1_000);
  });

  it('stops when nobody listens with NoSubscriberBehavior.Stop, and plays on with Play', async () => {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    player.play(createAudioResource(endless(), { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Idle, 1_000);

    const playing = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const resource = createAudioResource(endless(), { inputType: StreamType.Raw });
    playing.play(resource);
    await sleep(200);
    expect(playing.state.status).toBe(AudioPlayerStatus.Playing);
    expect(resource.playbackDuration).toBeGreaterThan(0);
    playing.stop(true);
  });

  it('stop() sends the silence padding first, stop(true) goes idle at once', async () => {
    await connect();
    player = createAudioPlayer();
    connection.subscribe(player);
    player.play(createAudioResource(endless(1000), { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Playing, 1_000);
    expect(player.stop()).toBe(true);
    expect(player.state.status).toBe(AudioPlayerStatus.Playing);
    await entersState(player, AudioPlayerStatus.Idle, 1_000);
    expect(firstSamples().slice(-5)).toEqual([0, 0, 0, 0, 0]);
    expect(player.stop()).toBe(false);

    player.play(createAudioResource(endless(), { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Playing, 1_000);
    player.stop(true);
    expect(player.state.status).toBe(AudioPlayerStatus.Idle);
  });

  it('refuses a resource that ended or that another player plays', async () => {
    player = createAudioPlayer();
    const resource = createAudioResource(endless(), { inputType: StreamType.Raw });
    player.play(resource);
    expect(() => createAudioPlayer().play(resource)).toThrow('This resource is already playing in another audio player.');
    player.stop(true);
    expect(resource.ended).toBe(true);
    expect(() => createAudioPlayer().play(resource)).toThrow('Cannot play a resource that has already ended.');
  });

  it('turns a broken stream into an AudioPlayerError and goes idle', async () => {
    await connect();
    player = createAudioPlayer();
    connection.subscribe(player);
    const stream = endless();
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 1_000);
    const failed = new Promise<AudioPlayerError>((resolve) => player.once('error', resolve));
    stream.destroy(new Error('the source broke'));
    const error = await failed;
    expect(error).toBeInstanceOf(AudioPlayerError);
    expect(error.message).toBe('the source broke');
    expect(error.resource).toBe(resource);
    expect(player.state.status).toBe(AudioPlayerStatus.Idle);
  });

  it('stops a resource that stops delivering', async () => {
    await connect();
    player = createAudioPlayer({ behaviors: { maxMissedFrames: 3 } });
    connection.subscribe(player);
    let pushed = 0;
    const stalling = new Readable({
      read() {
        if (pushed++ < 4) this.push(Buffer.alloc(FRAME, 1));
      },
    });
    player.play(createAudioResource(stalling, { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Idle, 2_000);
  });

  it('applies the inline volume to every frame', async () => {
    await connect();
    player = createAudioPlayer();
    connection.subscribe(player);
    const resource = createAudioResource(endless(1000), { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume!.setVolume(0.5);
    player.play(resource);
    await sleep(150);
    expect(firstSamples().at(-1)).toBe(500);
    resource.volume!.setVolumeDecibels(0);
    await sleep(150);
    expect(firstSamples().at(-1)).toBe(1000);
  });

  it('sends nothing while the connection is self muted', async () => {
    await connect();
    connection.rejoin({ channelId: 'c1', selfMute: true });
    player = createAudioPlayer();
    connection.subscribe(player);
    player.play(createAudioResource(endless(), { inputType: StreamType.Raw }));
    await sleep(150);
    expect(AudioSource.instances.at(-1)!.frames).toHaveLength(0);
  });
});
