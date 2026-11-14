import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import type { AudioPlayer } from './AudioPlayer.js';
import { transcodeToPcm } from './ffmpeg.js';
import { OpusPacketDecoder } from './opus.js';
import { FRAME_BYTES, FRAME_MS, SILENT_FRAME } from './pcm.js';
import { StreamType } from './StreamType.js';
import { VolumeTransformer } from './VolumeTransformer.js';

/**
 * Options for {@link createAudioResource}.
 */
export interface CreateAudioResourceOptions<Metadata> {
  /** What the input holds. Default {@link StreamType.Arbitrary} (FFmpeg reads it). Ignored for a path or URL unless {@link StreamType.Raw}. */
  inputType?: StreamType;
  /** Gives the resource a {@link VolumeTransformer} as `resource.volume`, so the volume can change while it plays. */
  inlineVolume?: boolean;
  /** Anything you want to keep with the resource, such as a track's title. */
  metadata?: Metadata;
  /** How many frames of silence to send after the end, so the sound fades out cleanly. Default 5. */
  silencePaddingFrames?: number;
}

/**
 * Something an {@link AudioPlayer} can play, made by {@link createAudioResource}. Inside, it is a stream of 48 kHz
 * stereo signed 16-bit samples, read 20 milliseconds at a time.
 */
export class AudioResource<Metadata = unknown> {
  /** The stream of samples the player reads from. */
  public readonly playStream: Readable;
  /** What you passed as `metadata`. */
  public metadata: Metadata;
  /** The volume, when the resource was made with `inlineVolume: true`. */
  public readonly volume?: VolumeTransformer;
  /** The player playing this resource, if any. */
  public audioPlayer?: AudioPlayer | undefined;
  /** How much of the resource has been played, in milliseconds. */
  public playbackDuration = 0;
  /** Whether the stream has produced audio yet. */
  public started = false;
  /** How many frames of silence follow the end. */
  public readonly silencePaddingFrames: number;
  /** Frames of silence still to send: -1 until the end is reached. */
  public silenceRemaining = -1;

  /**
   * @param playStream - Samples, signed 16-bit little-endian, 48 kHz stereo
   * @param metadata - Anything to keep with it
   * @param volume - The volume control, if any
   * @param padding - Frames of silence after the end
   */
  public constructor(playStream: Readable, metadata: Metadata, volume: VolumeTransformer | undefined, padding: number) {
    this.playStream = playStream;
    this.metadata = metadata;
    this.volume = volume;
    this.silencePaddingFrames = padding;
    if (playStream.readableLength > 0) this.started = true;
    else playStream.once('readable', () => (this.started = true));
  }

  /**
   * Whether the resource still has something to play (the stream, or the silence after it).
   */
  public get readable(): boolean {
    const left = this.silenceRemaining;
    if (left === 0) return false;
    if (this.playStream.readable) return true;
    // The stream is done: the silence after it starts now.
    if (left < 0) this.silenceRemaining = this.silencePaddingFrames;
    return this.silenceRemaining > 0;
  }

  /**
   * Whether the resource is finished: the stream ended or was destroyed, or its silence was sent.
   */
  public get ended(): boolean {
    const stream = this.playStream;
    return this.silenceRemaining === 0 || stream.destroyed || stream.readableEnded;
  }

  /**
   * Reads the next 20 milliseconds: a frame of samples, a frame of silence after the end, or `null` when nothing
   * is ready yet (or everything was played).
   */
  public read(): Buffer | null {
    if (this.silenceRemaining === 0) return null;
    if (this.silenceRemaining > 0) {
      this.silenceRemaining--;
      return SILENT_FRAME;
    }
    let chunk = this.playStream.read(FRAME_BYTES) as Buffer | null;
    if (chunk === null) return null;
    if (chunk.length < FRAME_BYTES) {
      // The last bit of a stream: filled up with silence.
      const whole = Buffer.alloc(FRAME_BYTES);
      chunk.copy(whole);
      chunk = whole;
    }
    this.playbackDuration += FRAME_MS;
    return this.volume ? this.volume.apply(chunk) : chunk;
  }
}

function isReadable(value: unknown): value is Readable {
  return typeof value === 'object' && value !== null && typeof (value as Readable).pipe === 'function' && typeof (value as Readable).read === 'function';
}

function rawStream(input: string | Readable): Readable {
  if (typeof input === 'string') return createReadStream(input);
  if (!input.readableObjectMode) return input;
  // Buffers of any size in object mode: turned into bytes so frames can be cut at any boundary.
  const bytes = new PassThrough();
  input.once('error', (error) => bytes.destroy(error));
  bytes.once('close', () => input.destroy());
  return input.pipe(bytes);
}

/**
 * Makes a resource an {@link AudioPlayer} can play.
 *
 * - A string is a path or a URL, read by FFmpeg (a path to a raw sample file with `inputType: StreamType.Raw`).
 * - A stream is read according to `inputType`: {@link StreamType.Raw} plays as it is, {@link StreamType.Opus}
 *   (Opus packets) is decoded here, and everything else goes through FFmpeg.
 *
 * FFmpeg must be installed for anything but raw samples and Opus packets; without it this throws.
 *
 * @example
 * ```js
 * const resource = createAudioResource('./music.mp3', { metadata: { title: 'A song' }, inlineVolume: true });
 * player.play(resource);
 * ```
 * @param input - A path, a URL, or a readable stream
 * @param options - How to read it
 */
export function createAudioResource<Metadata = null>(input: string | Readable, options: CreateAudioResourceOptions<Metadata> = {}): AudioResource<Metadata> {
  if (typeof input !== 'string' && !isReadable(input)) {
    throw new TypeError('createAudioResource needs a path, a URL or a readable stream');
  }
  const type = options.inputType ?? StreamType.Arbitrary;
  let stream: Readable;
  if (type === StreamType.Raw) {
    stream = rawStream(input);
  } else if (type === StreamType.Opus && typeof input !== 'string') {
    const decoder = new OpusPacketDecoder();
    input.once('error', (error) => decoder.destroy(error));
    decoder.once('close', () => input.destroy());
    stream = input.pipe(decoder);
  } else {
    stream = transcodeToPcm(input);
  }
  const volume = options.inlineVolume ? new VolumeTransformer() : undefined;
  const metadata = (options.metadata ?? null) as Metadata;
  return new AudioResource(stream, metadata, volume, options.silencePaddingFrames ?? 5);
}
