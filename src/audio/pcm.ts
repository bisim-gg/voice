import { Buffer } from 'node:buffer';

/** Every frame @bisim/voice handles lasts 20 milliseconds. */
export const FRAME_MS = 20;
/** The sample rate of all audio inside the library (and of Bisim's media). */
export const SAMPLE_RATE = 48_000;
/** Stereo. */
export const CHANNELS = 2;
/** Samples in one channel of one frame (960). */
export const FRAME_SAMPLES = (SAMPLE_RATE / 1_000) * FRAME_MS;
/** Bytes in one frame of signed 16-bit little-endian stereo audio (3840). */
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

/** One frame of silence. Callers must not write into it. */
export const SILENT_FRAME: Buffer = Buffer.alloc(FRAME_BYTES);

/**
 * Copies one PCM frame into a fresh, aligned Int16Array (a Buffer from a stream may start on an odd byte).
 *
 * @internal
 */
export function toSamples(frame: Buffer): Int16Array {
  const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
  Buffer.from(samples.buffer).set(frame.subarray(0, FRAME_BYTES));
  return samples;
}

/**
 * The loudness of a frame, in decibels relative to full scale (silence is -Infinity).
 *
 * @internal
 */
export function levelOf(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]! / 32_768;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}
