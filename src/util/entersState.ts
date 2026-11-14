import { once } from 'node:events';
import type { AudioPlayer, AudioPlayerStatus } from '../audio/AudioPlayer.js';
import type { VoiceConnection, VoiceConnectionStatus } from '../VoiceConnection.js';
import { abortAfter } from './abortAfter.js';

/**
 * Waits for a connection to reach a status.
 *
 * @param target - The connection
 * @param status - The status to wait for
 * @param timeoutOrSignal - Milliseconds to wait, or a signal that gives up
 * @returns The connection, once it is in that status
 * @throws An AbortError when the time runs out or the signal aborts first
 */
export function entersState(target: VoiceConnection, status: VoiceConnectionStatus, timeoutOrSignal: AbortSignal | number): Promise<VoiceConnection>;
/**
 * Waits for a player to reach a status.
 *
 * @param target - The player
 * @param status - The status to wait for
 * @param timeoutOrSignal - Milliseconds to wait, or a signal that gives up
 * @returns The player, once it is in that status
 * @throws An AbortError when the time runs out or the signal aborts first
 */
export function entersState(target: AudioPlayer, status: AudioPlayerStatus, timeoutOrSignal: AbortSignal | number): Promise<AudioPlayer>;
export async function entersState<Target extends AudioPlayer | VoiceConnection>(target: Target, status: string, timeoutOrSignal: AbortSignal | number): Promise<Target> {
  if (target.state.status === status) return target;
  const [controller, signal] = typeof timeoutOrSignal === 'number' ? abortAfter(timeoutOrSignal) : [undefined, timeoutOrSignal];
  try {
    await once(target as unknown as NodeJS.EventEmitter, status, { signal });
  } finally {
    controller?.abort();
  }
  return target;
}
