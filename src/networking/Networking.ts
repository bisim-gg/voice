import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import type {
  AudioSource,
  DisconnectReason,
  LocalAudioTrack,
  LocalTrackPublication,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  TrackPublication,
} from '@livekit/rtc-node';
import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE, toSamples } from '../audio/pcm.js';
import { loadRtc, type RtcModule } from './rtc.js';

/**
 * Where a {@link Networking} instance is.
 */
export enum NetworkingStatusCode {
  /** Connecting to the media server. */
  Connecting = 0,
  /** Connected, sending and receiving. */
  Ready = 1,
  /** The media server dropped the connection and LiveKit is getting it back. */
  Reconnecting = 2,
  /** Closed for good. */
  Closed = 3,
}

/**
 * The state of a {@link Networking} instance.
 */
export interface NetworkingState {
  code: NetworkingStatusCode;
}

/**
 * The close codes a {@link Networking} instance reports, named after Discord's voice close codes so a
 * `Disconnected` state reads the same.
 */
export const VoiceCloseCodes = {
  /** The connection could not be made at all. */
  ConnectFailed: 1006,
  /** The media server lost the bot and could not get it back: the connection rejoins by itself. */
  SessionLost: 4006,
  /** A moderator disconnected the bot, it lost the right to be there, or another session of the bot took the seat. Do not reconnect. */
  Disconnected: 4014,
  /** The call was ended for everyone (the channel was deleted). Do not reconnect. */
  CallTerminated: 4022,
} as const;

/**
 * What a {@link Networking} instance connects with: the answer to a voice join.
 */
export interface ConnectionData {
  /** The LiveKit signaling URL. */
  endpoint: string;
  /** The LiveKit access token. */
  token: string;
  /** The server. */
  guildId: string;
  /** The voice channel (LiveKit room). */
  channelId: string;
}

/**
 * Options for a {@link Networking} instance.
 */
export interface NetworkingOptions {
  /** Do not receive anyone's audio. */
  selfDeaf: boolean;
  /** Send no audio. */
  selfMute: boolean;
  /** Whether a moderator muted the bot (it cannot send sound then). */
  serverMute?: boolean;
  /** Emit `debug` events. */
  debug: boolean;
}

/** The data channel topic Bisim's apps use for voice signals in a call. */
const TOPIC = 'bisim-voice';
/** Frames waiting for the media layer; older ones are dropped beyond this (one second). */
const MAX_QUEUED_FRAMES = 50;
/** The bot's sound goes out at the bitrate Bisim reports for voice channels. */
const BITRATE = 64_000n;

function closeCodeFor(rtc: RtcModule, reason: DisconnectReason | undefined): number {
  switch (reason) {
    case rtc.DisconnectReason.PARTICIPANT_REMOVED:
    case rtc.DisconnectReason.DUPLICATE_IDENTITY:
      return VoiceCloseCodes.Disconnected;
    case rtc.DisconnectReason.ROOM_DELETED:
    case rtc.DisconnectReason.ROOM_CLOSED:
      return VoiceCloseCodes.CallTerminated;
    default:
      return VoiceCloseCodes.SessionLost;
  }
}

/**
 * One connection to a voice channel's LiveKit room: it publishes the bot's sound and reads what everyone else
 * sends. A {@link VoiceConnection} makes a new one for every join and destroys the old; you rarely touch it.
 *
 * Events: `stateChange` (old, new), `close` (code), `error` (error), `debug` (message), `audio` (userId,
 * samples), `participantLeave` (userId).
 */
export class Networking extends EventEmitter {
  /** The voice channel this connection is for. */
  public readonly channelId: string;
  /** The server. */
  public readonly guildId: string;

  private _state: NetworkingState = { code: NetworkingStatusCode.Connecting };
  private rtc: RtcModule | null = null;
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private published = false;
  private publishing: Promise<void> | null = null;
  private destroyed = false;
  private everReady = false;
  private selfDeaf: boolean;
  private selfMute: boolean;
  private serverMute: boolean;
  private speaking = false;
  private readonly readers = new Map<string, { userId: string; stop(): void }>();
  private readonly frames: Int16Array[] = [];
  private pumping = false;
  private readonly log: ((message: string) => void) | null;

  /**
   * @param data - The media server and token
   * @param options - How to behave
   */
  public constructor(data: ConnectionData, options: NetworkingOptions) {
    super();
    this.channelId = data.channelId;
    this.guildId = data.guildId;
    this.selfDeaf = options.selfDeaf;
    this.selfMute = options.selfMute;
    this.serverMute = options.serverMute ?? false;
    this.log = options.debug ? (message) => this.emit('debug', message) : null;
    void this.open(data);
  }

  /** The current state. */
  public get state(): NetworkingState {
    return this._state;
  }

  public set state(next: NetworkingState) {
    const previous = this._state;
    this._state = next;
    if (previous.code !== next.code) this.log?.(`state ${NetworkingStatusCode[previous.code]} -> ${NetworkingStatusCode[next.code]}`);
    this.emit('stateChange', previous, next);
  }

  /** Whether this connection was ever ready (a drop after that is rejoined; a failure before it is not). */
  public get wasReady(): boolean {
    return this.everReady;
  }

  /** The LiveKit room underneath, for advanced use. `null` until connected. */
  public get livekitRoom(): Room | null {
    return this.room;
  }

  private async open(data: ConnectionData): Promise<void> {
    let rtc: RtcModule;
    try {
      rtc = await loadRtc();
    } catch (error) {
      this.fail(new Error(`LiveKit's Node.js SDK (@livekit/rtc-node) could not be loaded: ${(error as Error).message}`));
      return;
    }
    if (this.destroyed) return;
    this.rtc = rtc;
    const room = new rtc.Room();
    this.room = room;
    this.bind(rtc, room);
    try {
      await room.connect(data.endpoint, data.token, { autoSubscribe: false, dynacast: false });
    } catch (error) {
      if (this.destroyed) return;
      this.fail(error as Error);
      return;
    }
    if (this.destroyed) {
      void room.disconnect().catch(() => undefined);
      return;
    }
    this.log?.(`in room ${data.channelId} as ${room.localParticipant?.identity ?? '?'}`);
    this.source = new rtc.AudioSource(SAMPLE_RATE, CHANNELS);
    await this.publish();
    if (this.destroyed) return;
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) this.consider(publication as RemoteTrackPublication);
    }
    this.everReady = true;
    this.announceState();
    this.state = { code: NetworkingStatusCode.Ready };
  }

  private fail(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else this.log?.(`error: ${error.message}`);
    this.close(VoiceCloseCodes.ConnectFailed);
  }

  private bind(rtc: RtcModule, room: Room): void {
    const E = rtc.RoomEvent;
    room.on(E.Disconnected, (reason: DisconnectReason) => {
      if (this.destroyed) return;
      this.log?.(`the media server ended the connection (${rtc.DisconnectReason[reason] ?? reason})`);
      this.close(closeCodeFor(rtc, reason));
    });
    room.on(E.Reconnecting, () => {
      if (!this.destroyed && this.everReady) this.state = { code: NetworkingStatusCode.Reconnecting };
    });
    room.on(E.Reconnected, () => {
      if (this.destroyed || !this.everReady) return;
      this.state = { code: NetworkingStatusCode.Ready };
      void this.publish();
    });
    room.on(E.TrackPublished, (publication: RemoteTrackPublication) => this.consider(publication));
    room.on(E.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === rtc.TrackKind.KIND_AUDIO && !this.selfDeaf) this.read(track, publication.sid ?? '', participant.identity);
    });
    room.on(E.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => this.stopReading(publication.sid ?? ''));
    room.on(E.TrackUnpublished, (publication: RemoteTrackPublication) => this.stopReading(publication.sid ?? ''));
    room.on(E.ParticipantConnected, (participant: RemoteParticipant) => {
      // The media server keeps no data messages, so each newcomer is told what the others already know.
      this.announceState([participant.identity]);
      if (this.speaking) this.sendData({ t: 'speaking', on: true }, [participant.identity]);
    });
    room.on(E.ParticipantDisconnected, (participant: RemoteParticipant) => {
      for (const [sid, reader] of this.readers) if (reader.userId === participant.identity) this.stopReading(sid);
      this.emit('participantLeave', participant.identity);
    });
    room.on(E.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
      if (publication.track !== this.track && publication.track !== undefined) return;
      // A moderator's server mute takes the microphone away; it is published again once lifted.
      this.published = false;
      this.log?.('the bot can no longer send sound here');
      const old = this.track;
      this.track = null;
      void old?.close(false).catch(() => undefined);
    });
  }

  private consider(publication: TrackPublication): void {
    const rtc = this.rtc;
    if (!rtc || publication.kind !== rtc.TrackKind.KIND_AUDIO) return;
    const remote = publication as RemoteTrackPublication;
    const wanted = !this.selfDeaf;
    if (remote.subscribed !== wanted) remote.setSubscribed(wanted);
  }

  private publish(): Promise<void> {
    if (this.publishing) return this.publishing;
    const rtc = this.rtc;
    const room = this.room;
    if (!rtc || !room?.localParticipant || !this.source || this.published || this.serverMute || this.destroyed) return Promise.resolve();
    this.publishing = (async () => {
      try {
        this.track ??= rtc.LocalAudioTrack.createAudioTrack('bisim-voice', this.source!);
        const options = new rtc.TrackPublishOptions({
          source: rtc.TrackSource.SOURCE_MICROPHONE,
          dtx: false,
          red: true,
          audioEncoding: { maxBitrate: BITRATE },
        });
        await room.localParticipant!.publishTrack(this.track, options);
        this.published = true;
        this.log?.('sending sound');
      } catch (error) {
        this.log?.(`cannot send sound here: ${(error as Error).message}`);
      } finally {
        this.publishing = null;
      }
    })();
    return this.publishing;
  }

  private read(track: RemoteTrack, sid: string, userId: string): void {
    const rtc = this.rtc;
    if (!rtc || this.readers.has(sid)) return;
    const stream = new rtc.AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: CHANNELS, frameSizeMs: 20 });
    const reader = stream.getReader();
    let stopped = false;
    const entry = {
      userId,
      stop: () => {
        stopped = true;
        void reader.cancel().catch(() => undefined);
      },
    };
    this.readers.set(sid, entry);
    this.log?.(`receiving ${userId}`);
    const frameLength = FRAME_SAMPLES * CHANNELS;
    let pending = new Int16Array(0);
    void (async () => {
      try {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          let data = value.data;
          if (value.channels !== CHANNELS || value.sampleRate !== SAMPLE_RATE) continue;
          if (pending.length > 0) {
            const joined = new Int16Array(pending.length + data.length);
            joined.set(pending);
            joined.set(data, pending.length);
            data = joined;
          }
          let offset = 0;
          while (data.length - offset >= frameLength) {
            this.emit('audio', userId, data.slice(offset, offset + frameLength));
            offset += frameLength;
          }
          pending = data.slice(offset);
        }
      } catch (error) {
        this.log?.(`stopped receiving ${userId}: ${(error as Error).message}`);
      } finally {
        if (this.readers.get(sid) === entry) this.readers.delete(sid);
      }
    })();
  }

  private stopReading(sid: string): void {
    const reader = this.readers.get(sid);
    if (!reader) return;
    this.readers.delete(sid);
    reader.stop();
  }

  /**
   * Sends one 20 ms frame of samples (48 kHz stereo, signed 16-bit little-endian).
   *
   * @param frame - 3840 bytes
   * @returns Whether it was queued
   */
  public sendFrame(frame: Buffer): boolean {
    if (!this.everReady || this.destroyed || this.selfMute || !this.source) return false;
    if (!this.published) {
      void this.publish();
      return false;
    }
    this.frames.push(toSamples(frame));
    if (this.frames.length > MAX_QUEUED_FRAMES) this.frames.shift();
    void this.pump();
    return true;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.frames.length > 0 && this.source && this.rtc && !this.destroyed) {
        const samples = this.frames.shift()!;
        await this.source.captureFrame(new this.rtc.AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
      }
    } catch (error) {
      this.log?.(`could not send a frame: ${(error as Error).message}`);
      this.frames.length = 0;
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Tells everyone in the call whether the bot is talking, so its ring lights up in Bisim's apps.
   *
   * @param speaking - Whether it is
   */
  public setSpeaking(speaking: boolean): void {
    const on = speaking && !this.selfMute;
    if (on === this.speaking) return;
    this.speaking = on;
    this.sendData({ t: 'speaking', on });
  }

  /**
   * Starts or stops receiving everyone's audio.
   *
   * @param deaf - `true` to stop receiving
   */
  public setSelfDeaf(deaf: boolean): void {
    if (deaf === this.selfDeaf) return;
    this.selfDeaf = deaf;
    if (deaf) for (const sid of [...this.readers.keys()]) this.stopReading(sid);
    for (const participant of this.room?.remoteParticipants.values() ?? []) {
      for (const publication of participant.trackPublications.values()) {
        this.consider(publication);
        const track = publication.track as RemoteTrack | undefined;
        if (!deaf && track && (publication as RemoteTrackPublication).subscribed && this.rtc && track.kind === this.rtc.TrackKind.KIND_AUDIO) {
          this.read(track, publication.sid ?? '', participant.identity);
        }
      }
    }
    this.announceState();
  }

  /**
   * Stops or starts sending audio.
   *
   * @param mute - `true` to send nothing
   */
  public setSelfMute(mute: boolean): void {
    if (mute === this.selfMute) return;
    if (mute) {
      this.setSpeaking(false);
      this.frames.length = 0;
    }
    this.selfMute = mute;
    this.announceState();
  }

  /**
   * Follows a moderator's server mute: while it lasts the bot cannot publish sound; once lifted it publishes again.
   *
   * @param mute - Whether the bot is server muted
   */
  public setServerMute(mute: boolean): void {
    this.serverMute = mute;
    if (!mute) void this.publish();
  }

  private announceState(to?: string[]): void {
    this.sendData({ t: 'state', muted: this.selfMute, deaf: this.selfDeaf, speaks: true }, to);
  }

  private sendData(message: Record<string, unknown>, to?: string[]): void {
    const participant = this.room?.localParticipant;
    if (!participant || this.destroyed || !this.room?.isConnected) return;
    const payload = new Uint8Array(Buffer.from(JSON.stringify(message)));
    void participant
      .publishData(payload, { reliable: true, topic: TOPIC, ...(to ? { destination_identities: to } : {}) })
      .catch(() => undefined);
  }

  private close(code: number): void {
    if (this._state.code === NetworkingStatusCode.Closed) return;
    this.cleanup();
    this.state = { code: NetworkingStatusCode.Closed };
    this.emit('close', code);
  }

  private cleanup(): void {
    for (const sid of [...this.readers.keys()]) this.stopReading(sid);
    this.frames.length = 0;
    const { room, track, source } = this;
    this.room = null;
    this.track = null;
    this.source = null;
    void (async () => {
      await room?.disconnect().catch(() => undefined);
      await track?.close(false).catch(() => undefined);
      await source?.close().catch(() => undefined);
    })();
  }

  /**
   * Leaves the room and frees everything. No `close` event follows.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanup();
    if (this._state.code !== NetworkingStatusCode.Closed) this.state = { code: NetworkingStatusCode.Closed };
  }
}
