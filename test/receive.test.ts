import OpusScript from 'opusscript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@livekit/rtc-node', () => import('./fakes/livekit.js'));

import {
  EndBehaviorType,
  SpeakingMap,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from '../src/index.js';
import { FakeAdapter, settle } from './fakes/adapter.js';
import { FakeRoom, reset, type RemoteAudioTrack } from './fakes/livekit.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One 20 ms stereo frame of a sine (or silence), continuing from sample `n`. */
function tone(freq: number | null, n: number, amplitude = 0.3): Int16Array {
  const samples = new Int16Array(1920);
  if (freq === null) return samples;
  for (let i = 0; i < 960; i++) {
    const value = Math.round(amplitude * 32_767 * Math.sin((2 * Math.PI * freq * (n + i)) / 48_000));
    samples[2 * i] = value;
    samples[2 * i + 1] = value;
  }
  return samples;
}

/** The strongest frequency in mono samples, by testing each candidate. */
function strongest(mono: number[], candidates: number[]): number {
  let best = candidates[0]!;
  let bestPower = -1;
  for (const freq of candidates) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < mono.length; i++) {
      re += mono[i]! * Math.cos((2 * Math.PI * freq * i) / 48_000);
      im += mono[i]! * Math.sin((2 * Math.PI * freq * i) / 48_000);
    }
    const power = re * re + im * im;
    if (power > bestPower) {
      bestPower = power;
      best = freq;
    }
  }
  return best;
}

let connection: VoiceConnection;
let track: RemoteAudioTrack;

async function connectWithSpeaker(selfDeaf = false): Promise<void> {
  const adapter = new FakeAdapter();
  connection = joinVoiceChannel({ channelId: 'c1', guildId: 'g1', adapterCreator: adapter.creator, selfDeaf });
  await entersState(connection, VoiceConnectionStatus.Ready, 1_000);
  const publication = FakeRoom.last.addSpeaker('alice');
  await settle();
  track = publication.track!;
}

async function speak(freq: number | null, frames: number, start = 0): Promise<void> {
  for (let i = 0; i < frames; i++) {
    track.push(tone(freq, (start + i) * 960));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function collect(stream: AudioReceiveStream): Buffer[] {
  const packets: Buffer[] = [];
  stream.on('data', (packet: Buffer) => packets.push(packet));
  return packets;
}

beforeEach(() => reset());

afterEach(() => {
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
});

describe('VoiceReceiver', () => {
  it('does not receive at all while self deafened', async () => {
    const adapter = new FakeAdapter();
    connection = joinVoiceChannel({ channelId: 'c1', guildId: 'g1', adapterCreator: adapter.creator });
    await entersState(connection, VoiceConnectionStatus.Ready, 1_000);
    const publication = FakeRoom.last.addSpeaker('alice');
    await settle();
    expect(publication.subscribed).toBe(false);
  });

  it('gives Opus packets of what a person says, which decode back to their voice', async () => {
    await connectWithSpeaker();
    const starts: string[] = [];
    connection.receiver.speaking.on('start', (userId) => starts.push(userId));
    const stream = connection.receiver.subscribe('alice');
    expect(connection.receiver.subscribe('alice')).toBe(stream);
    const packets = collect(stream);
    await speak(660, 25);
    expect(starts).toEqual(['alice']);
    expect(packets).toHaveLength(25);
    expect(Buffer.isBuffer(packets[0])).toBe(true);
    expect(packets[0]!.length).toBeLessThan(1000);
    const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    const mono: number[] = [];
    for (const packet of packets.slice(5)) {
      const pcm = Buffer.from(decoder.decode(packet));
      for (let i = 0; i < pcm.length; i += 4) mono.push(pcm.readInt16LE(i) / 32_768);
    }
    decoder.delete();
    expect(strongest(mono, [440, 550, 660, 880])).toBe(660);
  });

  it('leaves out the quiet stretches, as Discord does', async () => {
    await connectWithSpeaker();
    const packets = collect(connection.receiver.subscribe('alice', { mode: 'pcm' }));
    await speak(null, 10);
    expect(packets).toHaveLength(0);
    await speak(440, 5);
    expect(packets).toHaveLength(5);
  });

  it("gives samples with mode: 'pcm'", async () => {
    await connectWithSpeaker();
    const packets = collect(connection.receiver.subscribe('alice', { mode: 'pcm' }));
    await speak(440, 3);
    expect(packets).toHaveLength(3);
    expect(packets[0]!.length).toBe(3840);
    expect(packets[0]!.readInt16LE(4)).toBe(tone(440, 0)[2]);
  });

  it('ends an AfterSilence stream once the person was quiet long enough', async () => {
    await connectWithSpeaker();
    const stream = connection.receiver.subscribe('alice', { end: { behavior: EndBehaviorType.AfterSilence, duration: 100 } });
    collect(stream);
    let ended = false;
    stream.on('end', () => (ended = true));
    await speak(440, 5);
    await sleep(SpeakingMap.DELAY - 100);
    expect(ended).toBe(false);
    await sleep(350);
    expect(ended).toBe(true);
    expect(connection.receiver.subscriptions.has('alice')).toBe(false);
  });

  it('ends an AfterInactivity stream once no audio came for long enough', async () => {
    await connectWithSpeaker();
    const stream = connection.receiver.subscribe('alice', { end: { behavior: EndBehaviorType.AfterInactivity, duration: 80 } });
    collect(stream);
    let ended = false;
    stream.on('end', () => (ended = true));
    await speak(440, 3);
    await sleep(40);
    expect(ended).toBe(false);
    await sleep(150);
    expect(ended).toBe(true);
  });

  it('marks speaking start and end, and ends at once when the person leaves', async () => {
    await connectWithSpeaker();
    const events: string[] = [];
    connection.receiver.speaking.on('start', (userId) => events.push(`start ${userId}`));
    connection.receiver.speaking.on('end', (userId) => events.push(`end ${userId}`));
    await speak(440, 3);
    expect(connection.receiver.speaking.users.has('alice')).toBe(true);
    await sleep(SpeakingMap.DELAY + 50);
    expect(events).toEqual(['start alice', 'end alice']);
    await speak(440, 2);
    FakeRoom.last.emit('participantDisconnected', { identity: 'alice' });
    expect(events).toEqual(['start alice', 'end alice', 'start alice', 'end alice']);
  });

  it('closes every stream when the connection is destroyed', async () => {
    await connectWithSpeaker();
    const stream = connection.receiver.subscribe('alice');
    connection.destroy();
    await settle();
    expect(stream.destroyed).toBe(true);
  });
});
