// A stand-in for @livekit/rtc-node with just what @bisim/voice uses, so the state machines can be driven without a
// media server. Tests reach the rooms through `FakeRoom.instances`.
import { EventEmitter } from 'node:events';

export enum DisconnectReason {
  UNKNOWN_REASON = 0,
  CLIENT_INITIATED = 1,
  DUPLICATE_IDENTITY = 2,
  SERVER_SHUTDOWN = 3,
  PARTICIPANT_REMOVED = 4,
  ROOM_DELETED = 5,
  STATE_MISMATCH = 6,
  JOIN_FAILURE = 7,
  SIGNAL_CLOSE = 9,
  ROOM_CLOSED = 10,
}

export enum TrackKind {
  KIND_UNKNOWN = 0,
  KIND_AUDIO = 1,
  KIND_VIDEO = 2,
}

export enum TrackSource {
  SOURCE_UNKNOWN = 0,
  SOURCE_CAMERA = 1,
  SOURCE_MICROPHONE = 2,
}

export enum RoomEvent {
  ParticipantConnected = 'participantConnected',
  ParticipantDisconnected = 'participantDisconnected',
  LocalTrackUnpublished = 'localTrackUnpublished',
  TrackPublished = 'trackPublished',
  TrackUnpublished = 'trackUnpublished',
  TrackSubscribed = 'trackSubscribed',
  TrackUnsubscribed = 'trackUnsubscribed',
  Disconnected = 'disconnected',
  Reconnecting = 'reconnecting',
  Reconnected = 'reconnected',
}

export class AudioFrame {
  public constructor(
    public data: Int16Array,
    public sampleRate: number,
    public channels: number,
    public samplesPerChannel: number,
  ) {}

  public static create(sampleRate: number, channels: number, samplesPerChannel: number): AudioFrame {
    return new AudioFrame(new Int16Array(channels * samplesPerChannel), sampleRate, channels, samplesPerChannel);
  }
}

export class AudioSource {
  public static instances: AudioSource[] = [];
  public readonly frames: AudioFrame[] = [];
  public closed = false;

  public constructor(
    public sampleRate: number,
    public numChannels: number,
  ) {
    AudioSource.instances.push(this);
  }

  public async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.closed) throw new Error('AudioSource is closed');
    this.frames.push(frame);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

export class LocalAudioTrack {
  public closed = false;
  public constructor(
    public name: string,
    public source: AudioSource,
  ) {}

  public static createAudioTrack(name: string, source: AudioSource): LocalAudioTrack {
    return new LocalAudioTrack(name, source);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

export class TrackPublishOptions {
  public source?: TrackSource;
  public dtx?: boolean;
  public red?: boolean;
  public audioEncoding?: { maxBitrate?: bigint };
  public constructor(init: Partial<TrackPublishOptions> = {}) {
    Object.assign(this, init);
  }
}

/** A remote audio track: `push` hands frames to every AudioStream reading it. */
export class RemoteAudioTrack {
  public readonly kind = TrackKind.KIND_AUDIO;
  public readonly controllers = new Set<ReadableStreamDefaultController<AudioFrame>>();

  public push(samples: Int16Array, sampleRate = 48_000, channels = 2): void {
    const frame = new AudioFrame(samples, sampleRate, channels, samples.length / channels);
    for (const controller of this.controllers) controller.enqueue(frame);
  }
}

export class AudioStream extends ReadableStream<AudioFrame> {
  public constructor(track: RemoteAudioTrack, _options?: unknown) {
    let mine: ReadableStreamDefaultController<AudioFrame> | null = null;
    super({
      start(controller) {
        mine = controller;
        track.controllers.add(controller);
      },
      cancel() {
        if (mine) track.controllers.delete(mine);
      },
    });
  }
}

export class RemoteTrackPublication {
  public subscribed = false;
  public track: RemoteAudioTrack | undefined;
  public readonly kind = TrackKind.KIND_AUDIO;

  public constructor(
    public readonly sid: string,
    private readonly room: FakeRoom,
    public readonly participant: RemoteParticipant,
  ) {}

  public setSubscribed(subscribed: boolean): void {
    if (subscribed === this.subscribed) return;
    this.subscribed = subscribed;
    if (subscribed) {
      this.track = new RemoteAudioTrack();
      const track = this.track;
      queueMicrotask(() => this.room.emit(RoomEvent.TrackSubscribed, track, this, this.participant));
    } else {
      const track = this.track;
      this.track = undefined;
      queueMicrotask(() => this.room.emit(RoomEvent.TrackUnsubscribed, track, this, this.participant));
    }
  }
}

export class RemoteParticipant {
  public readonly trackPublications = new Map<string, RemoteTrackPublication>();
  public constructor(public readonly identity: string) {}
}

export class LocalParticipant {
  public readonly published: { track: LocalAudioTrack; options: TrackPublishOptions }[] = [];
  public readonly data: { message: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  public refusePublish = false;

  public constructor(public readonly identity: string) {}

  public async publishTrack(track: LocalAudioTrack, options: TrackPublishOptions): Promise<{ sid: string; track: LocalAudioTrack }> {
    if (this.refusePublish) throw new Error('does not have permission to publish');
    this.published.push({ track, options });
    return { sid: `TR_${this.published.length}`, track };
  }

  public async publishData(payload: Uint8Array, options: Record<string, unknown>): Promise<void> {
    this.data.push({ message: JSON.parse(Buffer.from(payload).toString('utf8')), options });
  }
}

let nextSid = 0;

export class FakeRoom extends EventEmitter {
  public static instances: FakeRoom[] = [];
  /** URLs containing this fail to connect. */
  public static failMarker = 'fail';

  public url = '';
  public token = '';
  public options: Record<string, unknown> = {};
  public localParticipant: LocalParticipant | undefined;
  public readonly remoteParticipants = new Map<string, RemoteParticipant>();
  public isConnected = false;
  public disconnected = false;

  public constructor() {
    super();
    FakeRoom.instances.push(this);
  }

  public static get last(): FakeRoom {
    return FakeRoom.instances[FakeRoom.instances.length - 1]!;
  }

  public async connect(url: string, token: string, options: Record<string, unknown>): Promise<void> {
    this.url = url;
    this.token = token;
    this.options = options;
    await Promise.resolve();
    if (url.includes(FakeRoom.failMarker)) throw new Error('could not establish signal connection');
    this.localParticipant = new LocalParticipant('bot');
    this.isConnected = true;
  }

  public async disconnect(): Promise<void> {
    this.disconnected = true;
    this.isConnected = false;
  }

  /** The media server ends the connection. */
  public drop(reason: DisconnectReason): void {
    this.isConnected = false;
    this.emit(RoomEvent.Disconnected, reason);
  }

  /** Someone joins and publishes a microphone. */
  public addSpeaker(identity: string): RemoteTrackPublication {
    const participant = new RemoteParticipant(identity);
    const publication = new RemoteTrackPublication(`PA_${++nextSid}`, this, participant);
    participant.trackPublications.set(publication.sid, publication);
    this.remoteParticipants.set(identity, participant);
    this.emit(RoomEvent.ParticipantConnected, participant);
    this.emit(RoomEvent.TrackPublished, publication, participant);
    return publication;
  }
}

export { FakeRoom as Room };

export function reset(): void {
  FakeRoom.instances = [];
  AudioSource.instances = [];
}
