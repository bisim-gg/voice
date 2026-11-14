import { Buffer } from 'node:buffer';
import { Transform, type TransformCallback } from 'node:stream';
import OpusScript from 'opusscript';
import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE } from './pcm.js';

/**
 * Encodes 20 ms frames of 48 kHz stereo samples into Opus packets, with the JavaScript build of libopus (no
 * native module to install).
 *
 * @internal
 */
export class OpusEncoder {
  private codec: OpusScript | null = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);

  /**
   * @param frame - One frame: 960 samples per channel, interleaved
   * @returns The Opus packet
   */
  public encode(frame: Buffer): Buffer {
    if (!this.codec) throw new Error('The Opus encoder was closed');
    // The result points into the codec's memory, which the next call reuses.
    return Buffer.from(this.codec.encode(frame, FRAME_SAMPLES));
  }

  /** Frees the codec. */
  public close(): void {
    this.codec?.delete();
    this.codec = null;
  }
}

/**
 * Decodes Opus packets into 48 kHz stereo samples.
 *
 * @internal
 */
export class OpusDecoder {
  private codec: OpusScript | null = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);

  /**
   * @param packet - One Opus packet
   * @returns The samples, signed 16-bit little-endian
   */
  public decode(packet: Buffer): Buffer {
    if (!this.codec) throw new Error('The Opus decoder was closed');
    return Buffer.from(this.codec.decode(packet));
  }

  /** Frees the codec. */
  public close(): void {
    this.codec?.delete();
    this.codec = null;
  }
}

/**
 * A stream that takes Opus packets (object mode) and gives samples (bytes).
 *
 * @internal
 */
export class OpusPacketDecoder extends Transform {
  private readonly decoder = new OpusDecoder();

  public constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }

  public override _transform(packet: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      if (packet.length > 0) this.push(this.decoder.decode(packet));
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  public override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    this.decoder.close();
    done(error);
  }
}
