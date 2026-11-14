import type { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { addAudioPlayer, deleteAudioPlayer } from '../DataStore.js';
import { VoiceConnectionStatus, type VoiceConnection } from '../VoiceConnection.js';
import { AudioPlayerError } from './AudioPlayerError.js';
import type { AudioResource } from './AudioResource.js';
import { FRAME_MS, SILENT_FRAME } from './pcm.js';
import { PlayerSubscription } from './PlayerSubscription.js';

/**
 * What a player does while no connection can play it.
 */
export enum NoSubscriberBehavior {
  /** Pause, and carry on once a connection is ready again (the default). */
  Pause = 'pause',
  /** Keep playing; the audio nobody hears is lost. */
  Play = 'play',
  /** Stop the resource. */
  Stop = 'stop',
}

/**
 * Where a player is.
 */
export enum AudioPlayerStatus {
  /** Paused by itself because no connection could play it. */
  AutoPaused = 'autopaused',
  /** Waiting for the resource to produce its first audio. */
  Buffering = 'buffering',
  /** Nothing to play. */
  Idle = 'idle',
  /** Paused with {@link AudioPlayer.pause}. */
  Paused = 'paused',
  /** Playing. */
  Playing = 'playing',
}

/**
 * Options for {@link createAudioPlayer}.
 */
export interface CreateAudioPlayerOptions {
  behaviors?: {
    /** What to do while no connection can play. Default {@link NoSubscriberBehavior.Pause}. */
    noSubscriber?: NoSubscriberBehavior;
    /** How many frames in a row the resource may fail to deliver before the player stops it. Default 5. */
    maxMissedFrames?: number;
  };
  /** Emit `debug` events (on unless `false`). */
  debug?: boolean;
}

/** The player has nothing to play. */
export interface AudioPlayerIdleState {
  status: AudioPlayerStatus.Idle;
}

/** The player waits for its resource to produce audio. */
export interface AudioPlayerBufferingState {
  status: AudioPlayerStatus.Buffering;
  resource: AudioResource;
}

/** The player is playing. */
export interface AudioPlayerPlayingState {
  status: AudioPlayerStatus.Playing;
  resource: AudioResource;
  /** Frames in a row the resource could not deliver. */
  missedFrames: number;
  /** How long this resource has been playing, in milliseconds. */
  playbackDuration: number;
}

/** The player is paused, by you or by itself. */
export interface AudioPlayerPausedState {
  status: AudioPlayerStatus.AutoPaused | AudioPlayerStatus.Paused;
  resource: AudioResource;
  /** Frames of silence still to send before going quiet. */
  silencePacketsRemaining: number;
  /** How long this resource has been playing, in milliseconds. */
  playbackDuration: number;
}

/** Every state a player can be in. */
export type AudioPlayerState = AudioPlayerBufferingState | AudioPlayerIdleState | AudioPlayerPausedState | AudioPlayerPlayingState;

export interface AudioPlayer extends EventEmitter {
  /**
   * A resource failed while playing.
   *
   * @eventProperty
   */
  on(event: 'error', listener: (error: AudioPlayerError) => void): this;
  /**
   * Something worth logging while debugging.
   *
   * @eventProperty
   */
  on(event: 'debug', listener: (message: string) => void): this;
  /**
   * The state changed.
   *
   * @eventProperty
   */
  on(event: 'stateChange', listener: (oldState: AudioPlayerState, newState: AudioPlayerState) => void): this;
  /**
   * A connection subscribed to or unsubscribed from the player.
   *
   * @eventProperty
   */
  on(event: 'subscribe' | 'unsubscribe', listener: (subscription: PlayerSubscription) => void): this;
  /**
   * The player entered this status.
   *
   * @eventProperty
   */
  on<Status extends AudioPlayerStatus>(
    event: Status,
    listener: (oldState: AudioPlayerState, newState: AudioPlayerState & { status: Status }) => void,
  ): this;
}

/** Frames of silence sent when pausing, so the sound does not stop on a click. */
const PAUSE_SILENCE_FRAMES = 5;
/** Frames sent at once when playback (re)starts, so the media layer has a little in hand against timer jitter. */
const LEAD_FRAMES = 3;
/** The events that end a resource's stream before it produced anything. */
const STREAM_ENDINGS = ['end', 'close', 'finish'] as const;

const P = AudioPlayerStatus;
type WithResource = Exclude<AudioPlayerState, AudioPlayerIdleState>;

function hasResource(state: AudioPlayerState): state is WithResource {
  return state.status !== P.Idle;
}

function idle(): AudioPlayerIdleState {
  return { status: P.Idle };
}

function playingFrom(resource: AudioResource, playbackDuration = 0): AudioPlayerPlayingState {
  return { status: P.Playing, resource, playbackDuration, missedFrames: 0 };
}

function pausedFrom(state: AudioPlayerPlayingState, status: AudioPlayerPausedState['status'], silence: number): AudioPlayerPausedState {
  return { status, resource: state.resource, playbackDuration: state.playbackDuration, silencePacketsRemaining: silence };
}

function describe(state: AudioPlayerState): string {
  return state.status === P.Playing ? `${state.status} (${state.playbackDuration} ms played)` : state.status;
}

/** What the player listens to on the stream of the resource it holds. */
interface StreamWatch {
  resource: AudioResource;
  onError: (error: Error) => void;
  onReadable: () => void;
  onEnded: () => void;
}

/**
 * Plays {@link AudioResource}s to every connection subscribed to it (`connection.subscribe(player)`). One player can
 * play into several servers at once.
 *
 * @example
 * ```js
 * const player = createAudioPlayer();
 * connection.subscribe(player);
 * player.play(createAudioResource('./song.mp3'));
 * player.on(AudioPlayerStatus.Idle, () => console.log('Finished'));
 * ```
 */
export class AudioPlayer extends EventEmitter {
  private current: AudioPlayerState = idle();
  private readonly subscribers: PlayerSubscription[] = [];
  private readonly behaviors: { noSubscriber: NoSubscriberBehavior; maxMissedFrames: number };
  private readonly log: ((message: string) => void) | null;
  private watch: StreamWatch | null = null;
  private lead = 0;

  /**
   * @param options - How the player behaves
   */
  public constructor(options: CreateAudioPlayerOptions = {}) {
    super();
    this.behaviors = {
      noSubscriber: options.behaviors?.noSubscriber ?? NoSubscriberBehavior.Pause,
      maxMissedFrames: options.behaviors?.maxMissedFrames ?? 5,
    };
    this.log = options.debug === false ? null : (message) => this.emit('debug', message);
  }

  /**
   * The subscribed connections that are ready to play.
   */
  public get playable(): VoiceConnection[] {
    const ready: VoiceConnection[] = [];
    for (const { connection } of this.subscribers) if (connection.state.status === VoiceConnectionStatus.Ready) ready.push(connection);
    return ready;
  }

  /**
   * Called by `connection.subscribe(player)`.
   *
   * @internal
   */
  protected subscribe(connection: VoiceConnection): PlayerSubscription {
    const found = this.subscribers.find((link) => link.connection === connection);
    if (found !== undefined) return found;
    const link = new PlayerSubscription(connection, this);
    this.subscribers.push(link);
    setImmediate(() => this.emit('subscribe', link));
    return link;
  }

  /**
   * Called by `subscription.unsubscribe()`.
   *
   * @internal
   */
  protected unsubscribe(link: PlayerSubscription): boolean {
    const at = this.subscribers.indexOf(link);
    if (at < 0) return false;
    this.subscribers.splice(at, 1)[0]!.connection.setSpeaking(false);
    this.emit('unsubscribe', link);
    return true;
  }

  /**
   * The player's state.
   */
  public get state(): AudioPlayerState {
    return this.current;
  }

  public set state(next: AudioPlayerState) {
    const before = this.current;
    const nextResource = hasResource(next) ? next.resource : undefined;
    const beforeResource = hasResource(before) ? before.resource : undefined;

    if (beforeResource && beforeResource !== nextResource) this.letGo(beforeResource);
    if (before.status === P.Buffering && (next.status !== P.Buffering || nextResource !== beforeResource)) this.stopWaiting();

    if (next.status === P.Idle) {
      this.stopSpeaking();
      deleteAudioPlayer(this);
    }
    if (nextResource) addAudioPlayer(this);

    const swapped = beforeResource !== undefined && next.status === P.Playing && beforeResource !== nextResource;
    if (next.status === P.Playing && (before.status !== P.Playing || swapped)) this.lead = LEAD_FRAMES;

    this.current = next;
    this.emit('stateChange', before, next);
    if (before.status !== next.status || swapped) this.emit(next.status, before, next as never);
    this.log?.(`state ${describe(before)} -> ${describe(next)}`);
  }

  /** Stops listening to a resource and ends its stream. */
  private letGo(resource: AudioResource): void {
    const stream = resource.playStream;
    if (this.watch?.resource === resource) {
      this.letGoListeners(this.watch);
      this.watch = null;
    }
    stream.on('error', () => undefined);
    resource.audioPlayer = undefined;
    stream.destroy();
    // Let go of anything still buffered.
    stream.read();
  }

  /** Stops waiting for the resource's first audio. */
  private stopWaiting(): void {
    const watch = this.watch;
    if (!watch) return;
    watch.resource.playStream.off('readable', watch.onReadable);
    for (const event of STREAM_ENDINGS) watch.resource.playStream.off(event, watch.onEnded);
  }

  /**
   * Plays a resource, replacing whatever was playing. The player buffers until the resource has audio, then plays.
   *
   * @param resource - The resource
   * @throws If the resource already ended, or another player is playing it
   */
  public play<Metadata>(resource: AudioResource<Metadata>): void {
    const item = resource as AudioResource;
    if (item.ended) throw new Error('Cannot play a resource that has already ended.');
    if (item.audioPlayer === this) return;
    if (item.audioPlayer) throw new Error('This resource is already playing in another audio player.');
    item.audioPlayer = this;

    const holds = () => hasResource(this.current) && this.current.resource === item;
    const watch: StreamWatch = {
      resource: item,
      onError: (error) => {
        if (!hasResource(this.current)) return;
        this.emit('error', new AudioPlayerError(error, this.current.resource));
        if (holds()) this.state = idle();
      },
      onReadable: () => {
        if (holds() && this.current.status === P.Buffering) this.state = playingFrom(item);
      },
      onEnded: () => {
        if (holds() && this.current.status === P.Buffering) this.state = idle();
      },
    };
    if (this.watch) this.letGoListeners(this.watch);
    item.playStream.once('error', watch.onError);

    if (item.started) {
      this.state = playingFrom(item);
      this.watch = watch;
      return;
    }
    item.playStream.once('readable', watch.onReadable);
    for (const event of STREAM_ENDINGS) item.playStream.once(event, watch.onEnded);
    this.state = { status: P.Buffering, resource: item };
    this.watch = watch;
  }

  private letGoListeners(watch: StreamWatch): void {
    const stream = watch.resource.playStream;
    stream.off('error', watch.onError);
    stream.off('readable', watch.onReadable);
    for (const event of STREAM_ENDINGS) stream.off(event, watch.onEnded);
  }

  /**
   * Pauses. Only a playing player pauses.
   *
   * @param interpolateSilence - Send a few frames of silence first, so the sound fades instead of clicking (default true)
   * @returns Whether it paused
   */
  public pause(interpolateSilence = true): boolean {
    if (this.current.status !== P.Playing) return false;
    this.state = pausedFrom(this.current, P.Paused, interpolateSilence ? PAUSE_SILENCE_FRAMES : 0);
    if (!interpolateSilence) this.stopSpeaking();
    return true;
  }

  /**
   * Carries on after {@link AudioPlayer.pause}.
   *
   * @returns Whether it was paused
   */
  public unpause(): boolean {
    if (this.current.status !== P.Paused) return false;
    this.state = playingFrom(this.current.resource, this.current.playbackDuration);
    return true;
  }

  /**
   * Stops playing and goes Idle, after the resource's silence padding unless `force` is set.
   *
   * @param force - Go Idle now
   * @returns Whether something was playing
   */
  public stop(force = false): boolean {
    const state = this.current;
    if (!hasResource(state)) return false;
    const padding = state.resource.silencePaddingFrames;
    if (force || state.status !== P.Playing || padding === 0) this.state = idle();
    else if (state.resource.silenceRemaining < 0) state.resource.silenceRemaining = padding;
    return true;
  }

  /**
   * Whether the player has something it can play now; a resource that ran out sends it Idle.
   */
  public checkPlayable(): boolean {
    const state = this.current;
    if (state.status === P.Idle || state.status === P.Buffering) return false;
    if (state.resource.readable) return true;
    this.state = idle();
    return false;
  }

  /**
   * One turn of the audio clock: sends the next 20 ms to every ready connection.
   *
   * @internal
   */
  protected stepFrame(): void {
    if (!this.checkPlayable()) return;
    const targets = this.playable;
    let state = this.current as AudioPlayerPausedState | AudioPlayerPlayingState;

    // Paused by itself: a connection is ready again.
    if (state.status === P.AutoPaused && targets.length > 0) {
      this.state = playingFrom(state.resource, state.playbackDuration);
      state = this.current as AudioPlayerPlayingState;
    }

    if (state.status !== P.Playing) {
      if (state.silencePacketsRemaining <= 0) return;
      state.silencePacketsRemaining -= 1;
      this.send(SILENT_FRAME, targets, false);
      if (state.silencePacketsRemaining === 0) this.stopSpeaking();
      return;
    }

    if (targets.length === 0 && this.behaviors.noSubscriber !== NoSubscriberBehavior.Play) {
      if (this.behaviors.noSubscriber === NoSubscriberBehavior.Stop) this.stop(true);
      else this.state = pausedFrom(state, P.AutoPaused, PAUSE_SILENCE_FRAMES);
      return;
    }

    const due = 1 + this.lead;
    this.lead = 0;
    for (let n = 0; n < due; n++) {
      const frame = state.resource.read();
      if (frame === null) {
        state.missedFrames += n === 0 ? 1 : 0;
        if (state.missedFrames >= this.behaviors.maxMissedFrames) this.stop();
        return;
      }
      state.missedFrames = 0;
      state.playbackDuration += FRAME_MS;
      this.send(frame, targets, true);
    }
  }

  private send(frame: Buffer, targets: VoiceConnection[], audible: boolean): void {
    for (const target of targets) {
      if (audible) target.setSpeaking(true);
      (target as unknown as { playFrame(frame: Buffer): void }).playFrame(frame);
    }
  }

  private stopSpeaking(): void {
    for (const link of this.subscribers) link.connection.setSpeaking(false);
  }
}

/**
 * Makes an audio player.
 *
 * @param options - How it behaves
 */
export function createAudioPlayer(options?: CreateAudioPlayerOptions): AudioPlayer {
  const player = new AudioPlayer(options);
  return player;
}
