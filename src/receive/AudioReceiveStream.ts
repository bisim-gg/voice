import type { Buffer } from 'node:buffer';
import { Readable, type ReadableOptions } from 'node:stream';

/**
 * When an {@link AudioReceiveStream} ends by itself.
 */
export enum EndBehaviorType {
  /** Never: you end it with `stream.destroy()`. */
  Manual = 0,
  /** After the person has been quiet for `duration` milliseconds. */
  AfterSilence = 1,
  /** After no audio arrived for `duration` milliseconds. On Bisim a quiet person sends no packets, so this is close to AfterSilence. */
  AfterInactivity = 2,
}

/**
 * When an {@link AudioReceiveStream} ends by itself.
 */
export type EndBehavior =
  | { behavior: EndBehaviorType.AfterInactivity | EndBehaviorType.AfterSilence; duration: number }
  | { behavior: EndBehaviorType.Manual };

/**
 * What a receive stream carries.
 *
 * - `'opus'` (the default): one Opus packet per Buffer, 20 ms each, 48 kHz stereo, as on Discord. Decode them
 *   with prism-media's `opus.Decoder` or keep them in an Ogg file.
 * - `'pcm'`: one Buffer of samples per 20 ms (3840 bytes: 960 samples per channel, two channels, signed
 *   16-bit little-endian, 48 kHz), with no decoding to do.
 */
export type AudioReceiveMode = 'opus' | 'pcm';

/**
 * Options for {@link VoiceReceiver.subscribe}.
 */
export interface AudioReceiveStreamOptions extends ReadableOptions {
  /** When the stream ends by itself. */
  end: EndBehavior;
  /** What the stream carries (Bisim). Default `'opus'`. */
  mode?: AudioReceiveMode;
}

/**
 * The options a subscription starts from: no end of its own, Opus packets.
 */
export function createDefaultAudioReceiveStreamOptions(): AudioReceiveStreamOptions {
  return { end: { behavior: EndBehaviorType.Manual }, mode: 'opus' };
}

/**
 * The audio of one person in the call, as a readable stream of Buffers (object mode): Opus packets by default, or
 * samples with `mode: 'pcm'`. It carries what the person says: a quiet stretch sends nothing, as on Discord.
 */
export class AudioReceiveStream extends Readable {
  /** When the stream ends by itself. */
  public readonly end: EndBehavior;
  /** What the stream carries. */
  public readonly mode: AudioReceiveMode;

  private endTimer: NodeJS.Timeout | undefined;

  /**
   * @param options - When it ends and what it carries
   */
  public constructor(options: AudioReceiveStreamOptions) {
    const { end, mode = 'opus', ...rest } = options;
    super({ ...rest, objectMode: true });
    this.end = end;
    this.mode = mode;
  }

  /**
   * Adds a packet (or `null` to end the stream).
   *
   * @param packet - An Opus packet or a frame of samples
   */
  public override push(packet: Buffer | null): boolean {
    if (packet === null) {
      this.clearEndTimer();
      setImmediate(() => this.destroy());
      return super.push(null);
    }
    if (this.end.behavior === EndBehaviorType.AfterInactivity) this.armEndTimer(this.end.duration);
    return super.push(packet);
  }

  /**
   * The person started speaking.
   *
   * @internal
   */
  public speakingStarted(): void {
    if (this.end.behavior === EndBehaviorType.AfterSilence) this.clearEndTimer();
  }

  /**
   * The person went quiet.
   *
   * @internal
   */
  public speakingEnded(): void {
    if (this.end.behavior === EndBehaviorType.AfterSilence) this.armEndTimer(this.end.duration);
  }

  private armEndTimer(duration: number): void {
    this.clearEndTimer();
    this.endTimer = setTimeout(() => {
      this.endTimer = undefined;
      if (!this.readableEnded && !this.destroyed) this.push(null);
    }, duration);
  }

  private clearEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = undefined;
  }

  public override _read(): void {
    // Packets are pushed as they arrive.
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearEndTimer();
    callback(error);
  }
}
