import { Buffer } from 'node:buffer';

/**
 * The volume of an {@link AudioResource} made with `inlineVolume: true`, with the methods prism-media's volume
 * transformer has. A change is heard within a few frames, since the volume is applied as each frame is read.
 *
 * @example
 * ```js
 * const resource = createAudioResource('song.mp3', { inlineVolume: true });
 * resource.volume.setVolume(0.5); // half
 * resource.volume.setVolumeDecibels(-6);
 * ```
 */
export class VolumeTransformer {
  private level: number;

  /**
   * @param volume - The starting volume, 1 being unchanged
   */
  public constructor(volume = 1) {
    this.level = VolumeTransformer.check(volume);
  }

  private static check(volume: number): number {
    if (!Number.isFinite(volume) || volume < 0) throw new RangeError(`A volume must be a number of 0 or more, not ${volume}`);
    return volume;
  }

  /** The volume as a factor: 1 leaves the sound as it is, 0.5 halves it, 2 doubles it. */
  public get volume(): number {
    return this.level;
  }

  /** The volume in decibels: 0 leaves the sound as it is, -6 is about half. */
  public get volumeDecibels(): number {
    return Math.log10(this.level) * 20;
  }

  /** The volume on a curve that sounds even to the ear (0 to 1 maps onto a factor of 0 to 1). */
  public get volumeLogarithmic(): number {
    return this.level ** (1 / 1.660_964);
  }

  /**
   * Sets the volume as a factor.
   *
   * @param volume - 1 leaves the sound as it is
   */
  public setVolume(volume: number): void {
    this.level = VolumeTransformer.check(volume);
  }

  /**
   * Sets the volume in decibels.
   *
   * @param db - 0 leaves the sound as it is
   */
  public setVolumeDecibels(db: number): void {
    this.setVolume(10 ** (db / 20));
  }

  /**
   * Sets the volume on a curve that sounds even to the ear.
   *
   * @param value - From 0 (silent) to 1 (unchanged)
   */
  public setVolumeLogarithmic(value: number): void {
    this.setVolume(value ** 1.660_964);
  }

  /**
   * Returns a frame of 16-bit samples scaled by the volume (clipped to the sample range).
   *
   * @param frame - Signed 16-bit little-endian samples
   * @internal
   */
  public apply(frame: Buffer): Buffer {
    if (this.level === 1) return frame;
    const out = Buffer.allocUnsafe(frame.length - (frame.length % 2));
    for (let offset = 0; offset < out.length; offset += 2) {
      const scaled = Math.round(frame.readInt16LE(offset) * this.level);
      out.writeInt16LE(scaled > 32_767 ? 32_767 : scaled < -32_768 ? -32_768 : scaled, offset);
    }
    return out;
  }
}
