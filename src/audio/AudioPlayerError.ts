import type { AudioResource } from './AudioResource.js';

/**
 * An error while playing a resource (FFmpeg failed, the input stream broke), with the resource it happened on.
 * The player goes back to Idle after emitting it.
 */
export class AudioPlayerError extends Error {
  /** The resource that was playing. */
  public readonly resource: AudioResource;

  /**
   * @param error - What went wrong
   * @param resource - The resource that was playing
   */
  public constructor(error: Error, resource: AudioResource) {
    super(error.message);
    this.name = 'AudioPlayerError';
    this.resource = resource;
    this.stack = error.stack;
    this.cause = error;
  }
}
