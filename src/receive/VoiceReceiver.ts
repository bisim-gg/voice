import { Buffer } from 'node:buffer';
import { OpusEncoder } from '../audio/opus.js';
import { levelOf } from '../audio/pcm.js';
import type { VoiceConnection } from '../VoiceConnection.js';
import { AudioReceiveStream, createDefaultAudioReceiveStreamOptions, type AudioReceiveStreamOptions } from './AudioReceiveStream.js';
import { SpeakingMap } from './SpeakingMap.js';

/**
 * Sound above this level (decibels relative to full scale) counts as speaking: the level Bisim's apps light the
 * speaking ring at.
 */
export const SPEAKING_THRESHOLD_DB = -50;

/**
 * Receives what the others in the call say. Join with `selfDeaf: false` to use it: a deafened connection receives
 * nothing, and Bisim enforces that on its media server, whatever the code asks for. A bot joins deafened unless it
 * says otherwise.
 *
 * @example
 * ```js
 * const connection = joinVoiceChannel({ channelId, guildId, adapterCreator, selfDeaf: false });
 * connection.receiver.speaking.on('start', (userId) => {
 *   const opus = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
 *   opus.on('data', (packet) => console.log(userId, packet.length));
 * });
 * ```
 */
export class VoiceReceiver {
  /** The connection this receiver belongs to. */
  public readonly voiceConnection: VoiceConnection;
  /** The open subscriptions, by user id. */
  public readonly subscriptions = new Map<string, AudioReceiveStream>();
  /** Who is speaking. */
  public readonly speaking = new SpeakingMap();

  private readonly encoders = new Map<string, OpusEncoder>();

  /**
   * @param connection - The connection
   */
  public constructor(connection: VoiceConnection) {
    this.voiceConnection = connection;
    this.onAudio = this.onAudio.bind(this);
    this.onParticipantLeave = this.onParticipantLeave.bind(this);
    this.speaking.on('start', (userId: string) => this.subscriptions.get(userId)?.speakingStarted());
    this.speaking.on('end', (userId: string) => this.subscriptions.get(userId)?.speakingEnded());
  }

  /**
   * Opens a stream of what one person says. Asking again for the same person returns the open stream.
   *
   * @param userId - The person
   * @param options - When the stream ends, and whether it carries Opus packets or samples
   * @returns The stream
   */
  public subscribe(userId: string, options?: Partial<AudioReceiveStreamOptions>): AudioReceiveStream {
    const open = this.subscriptions.get(userId);
    if (open && !open.destroyed) return open;
    const opened = new AudioReceiveStream({ ...createDefaultAudioReceiveStreamOptions(), ...options });
    opened.once('close', () => {
      if (this.subscriptions.get(userId) !== opened) return;
      this.subscriptions.delete(userId);
      this.dropEncoder(userId);
    });
    this.subscriptions.set(userId, opened);
    return opened;
  }

  /**
   * One 20 ms frame of a person's audio, from the media connection.
   *
   * @param userId - Whose
   * @param samples - 960 samples per channel, stereo
   * @internal
   */
  public onAudio(userId: string, samples: Int16Array): void {
    if (levelOf(samples) > SPEAKING_THRESHOLD_DB) this.speaking.onPacket(userId);
    if (!this.speaking.users.has(userId)) return;
    const target = this.subscriptions.get(userId);
    if (!target || target.destroyed || target.readableEnded) return;
    const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    if (target.mode === 'pcm') {
      target.push(Buffer.from(pcm));
      return;
    }
    let encoder = this.encoders.get(userId);
    if (!encoder) {
      encoder = new OpusEncoder();
      this.encoders.set(userId, encoder);
    }
    try {
      target.push(encoder.encode(pcm));
    } catch (failure) {
      target.destroy(failure as Error);
    }
  }

  /**
   * A person left the call.
   *
   * @param userId - Who
   * @internal
   */
  public onParticipantLeave(userId: string): void {
    this.speaking.finish(userId);
  }

  private dropEncoder(userId: string): void {
    this.encoders.get(userId)?.close();
    this.encoders.delete(userId);
  }

  /**
   * Ends every subscription (the connection was destroyed).
   *
   * @internal
   */
  public close(): void {
    this.speaking.clear();
    for (const stream of this.subscriptions.values()) if (!stream.destroyed) stream.destroy();
    for (const userId of [...this.encoders.keys()]) this.dropEncoder(userId);
  }
}
