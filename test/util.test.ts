import { readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import OpusScript from 'opusscript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AudioPlayerStatus,
  StreamType,
  VolumeTransformer,
  createAudioPlayer,
  createAudioResource,
  createJoinVoiceChannelPayload,
  demuxProbe,
  entersState,
  findFFmpeg,
  generateDependencyReport,
  validateBisimOpusHead,
  version,
} from '../src/index.js';

const FRAME = 3840;

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function bytes(buffer: Buffer): Readable {
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
}

function opusHead(channels = 2, rate = 48_000): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head.writeUInt8(1, 8);
  head.writeUInt8(channels, 9);
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(rate, 12);
  return head;
}

function oggPage(payload: Buffer): Buffer {
  const header = Buffer.alloc(28);
  header.write('OggS', 0, 'latin1');
  header.writeUInt8(2, 5);
  header.writeUInt8(1, 26);
  header.writeUInt8(payload.length, 27);
  return Buffer.concat([header, payload]);
}

describe('VolumeTransformer', () => {
  it('scales, clips and converts between the three scales', () => {
    const volume = new VolumeTransformer();
    const frame = Buffer.alloc(8);
    frame.writeInt16LE(1000, 0);
    frame.writeInt16LE(-1000, 2);
    frame.writeInt16LE(30_000, 4);
    frame.writeInt16LE(-30_000, 6);
    expect(volume.apply(frame)).toBe(frame);
    volume.setVolume(0.5);
    expect([0, 2].map((o) => volume.apply(frame).readInt16LE(o))).toEqual([500, -500]);
    volume.setVolume(2);
    expect([4, 6].map((o) => volume.apply(frame).readInt16LE(o))).toEqual([32_767, -32_768]);
    volume.setVolumeDecibels(-6);
    expect(volume.volume).toBeCloseTo(0.501, 3);
    expect(volume.volumeDecibels).toBeCloseTo(-6, 5);
    volume.setVolumeLogarithmic(0.5);
    expect(volume.volumeLogarithmic).toBeCloseTo(0.5, 5);
    expect(() => volume.setVolume(-1)).toThrow(RangeError);
  });
});

describe('AudioResource', () => {
  it('reads 20 ms frames, fills the last one with silence and counts what was read', async () => {
    const stream = Readable.from([Buffer.alloc(FRAME + 100, 7)]);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    expect(resource.metadata).toBeNull();
    await new Promise((resolve) => stream.once('readable', resolve));
    const first = resource.read()!;
    expect(first.length).toBe(FRAME);
    await new Promise((resolve) => setImmediate(resolve));
    const last = resource.read()!;
    expect(last.length).toBe(FRAME);
    expect(last[99]).toBe(7);
    expect(last[100]).toBe(0);
    expect(resource.playbackDuration).toBe(40);
  });

  it('cuts frames out of an object mode stream of any sized buffers', async () => {
    const pieces = [Buffer.alloc(1000, 1), Buffer.alloc(3000, 2), Buffer.alloc(3680, 3)];
    const resource = createAudioResource(Readable.from(pieces), { inputType: StreamType.Raw });
    const all = await drain(resource.playStream);
    expect(all.length).toBe(7680);
  });

  it('decodes a stream of Opus packets by itself', async () => {
    const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    const packets = Array.from({ length: 5 }, () => Buffer.from(encoder.encode(Buffer.alloc(FRAME), 960)));
    encoder.delete();
    const resource = createAudioResource(Readable.from(packets), { inputType: StreamType.Opus });
    const pcm = await drain(resource.playStream);
    expect(pcm.length).toBe(5 * FRAME);
  });

  it('plays through a player to the end even without a connection, with NoSubscriberBehavior.Play', async () => {
    const player = createAudioPlayer({ behaviors: { noSubscriber: 'play' as never } });
    const resource = createAudioResource(Readable.from([Buffer.alloc(FRAME * 3)]), { inputType: StreamType.Raw, silencePaddingFrames: 0 });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Idle, 2_000);
    expect(resource.playbackDuration).toBe(60);
  });
});

describe('FFmpeg', () => {
  const saved = { path: process.env.PATH, ffmpeg: process.env.FFMPEG_PATH };
  afterEach(() => {
    process.env.PATH = saved.path;
    if (saved.ffmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved.ffmpeg;
    findFFmpeg(true);
  });

  it('says clearly when FFmpeg is missing', () => {
    process.env.FFMPEG_PATH = '/nowhere/ffmpeg-missing';
    process.env.PATH = '';
    expect(findFFmpeg(true)).toBeNull();
    expect(() => createAudioResource('song.mp3')).toThrow(/FFmpeg was not found/);
    expect(generateDependencyReport()).toMatch(/FFmpeg[\s\S]*not found/);
  });
});

describe('demuxProbe', () => {
  it('finds Ogg Opus and gives the stream back whole', async () => {
    const bytes = Buffer.concat([oggPage(opusHead()), Buffer.alloc(2000, 5)]);
    const source = new PassThrough();
    source.end(bytes);
    const { stream, type } = await demuxProbe(source);
    expect(type).toBe(StreamType.OggOpus);
    expect((await drain(stream)).equals(bytes)).toBe(true);
  });

  it('calls an Ogg file with other audio, or a mono Opus header, Arbitrary', async () => {
    const vorbis = Buffer.concat([oggPage(Buffer.from('\x01vorbis\x00\x00\x00\x00\x02')), Buffer.alloc(100)]);
    expect((await demuxProbe(bytes(vorbis))).type).toBe(StreamType.Arbitrary);
    expect((await demuxProbe(bytes(oggPage(opusHead(1))))).type).toBe(StreamType.Arbitrary);
    expect(validateBisimOpusHead(opusHead())).toBe(true);
    expect(validateBisimOpusHead(opusHead(2, 44_100))).toBe(false);
  });

  it('finds WebM Opus, and calls an mp3 Arbitrary', async () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40), Buffer.from('A_OPUS'), Buffer.alloc(10), opusHead(), Buffer.alloc(50)]);
    expect((await demuxProbe(bytes(webm))).type).toBe(StreamType.WebmOpus);
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(500)]);
    const probed = await demuxProbe(bytes(mp3));
    expect(probed.type).toBe(StreamType.Arbitrary);
    expect((await drain(probed.stream)).equals(mp3)).toBe(true);
  });

  it('refuses an object mode stream', async () => {
    await expect(demuxProbe(new Readable({ objectMode: true, read() {} }))).rejects.toThrow(/object mode/);
  });
});

describe('the rest', () => {
  it('builds the op 4 payload bisim.js reads', () => {
    const config = { channelId: 'c', guildId: 'g', group: 'default', selfDeaf: true, selfMute: false };
    expect(createJoinVoiceChannelPayload(config)).toEqual({ op: 4, d: { guild_id: 'g', channel_id: 'c', self_mute: false, self_deaf: true } });
    expect(createJoinVoiceChannelPayload(config, true).d.connect).toBe(true);
  });

  it('entersState resolves at once, on the event, or rejects after the timeout', async () => {
    const player = createAudioPlayer();
    await expect(entersState(player, AudioPlayerStatus.Idle, 10)).resolves.toBe(player);
    await expect(entersState(player, AudioPlayerStatus.Playing, 30)).rejects.toThrow(/aborted/i);
    const controller = new AbortController();
    const waiting = entersState(player, AudioPlayerStatus.Playing, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/i);
  });

  it('reports its own version, the same as package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(version).toBe(pkg.version);
    expect(generateDependencyReport()).toContain(`@bisim/voice: ${pkg.version}`);
  });
});
