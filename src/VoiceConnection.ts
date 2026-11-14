import type { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import type { AudioPlayer } from './audio/AudioPlayer.js';
import { OpusDecoder } from './audio/opus.js';
import type { PlayerSubscription } from './audio/PlayerSubscription.js';
import { createJoinVoiceChannelPayload, getVoiceConnection, trackVoiceConnection, untrackVoiceConnection, type JoinConfig } from './DataStore.js';
import { Networking, NetworkingStatusCode, VoiceCloseCodes, type NetworkingState } from './networking/Networking.js';
import { VoiceReceiver } from './receive/VoiceReceiver.js';
import type { BisimGatewayAdapterCreator, BisimGatewayAdapterImplementerMethods, BisimVoiceServerUpdateData, BisimVoiceStateUpdateData } from './util/adapter.js';

/**
 * Where a voice connection is.
 */
export enum VoiceConnectionStatus {
  /** The connection details arrived; connecting to the media server. */
  Connecting = 'connecting',
  /** Destroyed for good; make a new connection to join again. */
  Destroyed = 'destroyed',
  /** Not connected and not trying to; {@link VoiceConnection.rejoin} tries again. */
  Disconnected = 'disconnected',
  /** Connected: audio flows both ways. */
  Ready = 'ready',
  /** The join was asked for; waiting for the connection details. */
  Signalling = 'signalling',
}

/**
 * Why a connection is Disconnected.
 */
export enum VoiceConnectionDisconnectReason {
  /** The media connection closed; `closeCode` says how (4014: removed by a moderator, 4022: the call ended, 1006: it could not connect). */
  WebSocketClose = 0,
  /** The adapter could not send the request. */
  AdapterUnavailable = 1,
  /** There is nowhere to connect: the join was refused. */
  EndpointRemoved = 2,
  /** You called {@link VoiceConnection.disconnect}. */
  Manual = 3,
}

/** Waiting for the connection details after asking to join. */
export interface VoiceConnectionSignallingState {
  status: VoiceConnectionStatus.Signalling;
  adapter: BisimGatewayAdapterImplementerMethods;
  subscription?: PlayerSubscription | undefined;
}

/** Connecting to the media server. */
export interface VoiceConnectionConnectingState {
  status: VoiceConnectionStatus.Connecting;
  adapter: BisimGatewayAdapterImplementerMethods;
  networking: Networking;
  subscription?: PlayerSubscription | undefined;
}

/** Connected. */
export interface VoiceConnectionReadyState {
  status: VoiceConnectionStatus.Ready;
  adapter: BisimGatewayAdapterImplementerMethods;
  networking: Networking;
  subscription?: PlayerSubscription | undefined;
}

/** What every Disconnected state has. */
export interface VoiceConnectionDisconnectedBaseState {
  status: VoiceConnectionStatus.Disconnected;
  adapter: BisimGatewayAdapterImplementerMethods;
  subscription?: PlayerSubscription | undefined;
}

/** Disconnected for a reason other than the media connection closing. */
export interface VoiceConnectionDisconnectedOtherState extends VoiceConnectionDisconnectedBaseState {
  reason: Exclude<VoiceConnectionDisconnectReason, VoiceConnectionDisconnectReason.WebSocketClose>;
}

/** Disconnected because the media connection closed. */
export interface VoiceConnectionDisconnectedWebSocketState extends VoiceConnectionDisconnectedBaseState {
  reason: VoiceConnectionDisconnectReason.WebSocketClose;
  /** How it closed: see {@link VoiceCloseCodes}. */
  closeCode: number;
}

/** Disconnected. */
export type VoiceConnectionDisconnectedState = VoiceConnectionDisconnectedOtherState | VoiceConnectionDisconnectedWebSocketState;

/** Destroyed. */
export interface VoiceConnectionDestroyedState {
  status: VoiceConnectionStatus.Destroyed;
}

/** Every state a connection can be in. */
export type VoiceConnectionState = VoiceConnectionSignallingState | VoiceConnectionConnectingState | VoiceConnectionReadyState | VoiceConnectionDisconnectedState | VoiceConnectionDestroyedState;

/**
 * Options for making a connection.
 */
export interface CreateVoiceConnectionOptions {
  /** How the connection reaches Bisim: `guild.voiceAdapterCreator` from bisim.js. */
  adapterCreator: BisimGatewayAdapterCreator;
  /** Emit `debug` events. Default false. */
  debug?: boolean | undefined;
  /** Accepted for compatibility: Bisim's media is encrypted in transit by LiveKit, with nothing to set up. */
  daveEncryption?: boolean | undefined;
  /** Accepted for compatibility. */
  decryptionFailureTolerance?: number | undefined;
}

export interface VoiceConnection extends EventEmitter {
  /**
   * Something went wrong (only emitted while someone listens; otherwise it goes to `debug`).
   *
   * @eventProperty
   */
  on(event: 'error', listener: (error: Error) => void): this;
  /**
   * Something worth logging while debugging (with `debug: true`).
   *
   * @eventProperty
   */
  on(event: 'debug', listener: (message: string) => void): this;
  /**
   * The state changed.
   *
   * @eventProperty
   */
  on(event: 'stateChange', listener: (oldState: VoiceConnectionState, newState: VoiceConnectionState) => void): this;
  /**
   * The connection entered this status.
   *
   * @eventProperty
   */
  on<Status extends VoiceConnectionStatus>(
    event: Status,
    listener: (oldState: VoiceConnectionState, newState: VoiceConnectionState & { status: Status }) => void,
  ): this;
}

type LiveState = Exclude<VoiceConnectionState, VoiceConnectionDestroyedState>;
type Carry = Pick<LiveState, 'adapter' | 'subscription'>;
type JoinChange = Partial<Omit<JoinConfig, 'group' | 'guildId'>>;

const S = VoiceConnectionStatus;
const Why = VoiceConnectionDisconnectReason;

function networkingOf(state: VoiceConnectionState): Networking | undefined {
  return state.status === S.Connecting || state.status === S.Ready ? state.networking : undefined;
}

function carry(from: LiveState): Carry {
  return { adapter: from.adapter, subscription: from.subscription };
}

function signallingFrom(from: LiveState): VoiceConnectionSignallingState {
  return { ...carry(from), status: S.Signalling };
}

function disconnectedFrom(from: LiveState, why: VoiceConnectionDisconnectedOtherState['reason']): VoiceConnectionDisconnectedOtherState {
  return { ...carry(from), status: S.Disconnected, reason: why };
}

function closedFrom(from: LiveState, closeCode: number): VoiceConnectionDisconnectedWebSocketState {
  return { ...carry(from), status: S.Disconnected, reason: Why.WebSocketClose, closeCode };
}

/**
 * A bot's connection to a voice channel in one server. Make one with {@link joinVoiceChannel}.
 *
 * Underneath, the adapter asks Bisim's API to join (which answers with a LiveKit address and token), and the
 * connection joins that LiveKit room: the bot publishes one sound track and receives everyone else's.
 */
export class VoiceConnection extends EventEmitter {
  /** Rejoins in a row without reaching Ready; back to 0 once Ready. */
  public rejoinAttempts = 0;
  /** Where the connection is, or wants to be, and how. */
  public readonly joinConfig: JoinConfig;
  /** Receives what the others say (join with `selfDeaf: false`). */
  public readonly receiver: VoiceReceiver = new VoiceReceiver(this);

  private current: VoiceConnectionState;
  /** The newest connection details from the adapter. */
  private details: BisimVoiceServerUpdateData | undefined;
  private readonly log: ((message: string) => void) | null;
  /** The mute and deafen the last join carried, to send a change made while it was on its way. */
  private joinedWith: { selfMute: boolean; selfDeaf: boolean } | null = null;
  /** The channel of a join that was asked for and not answered yet. */
  private pendingChannel: string | null = null;
  private serverMute = false;
  private decoder: OpusDecoder | null = null;
  private prepared: Buffer | null = null;
  /** What the connection listens to on its media connection. */
  private readonly wiring: [event: string, listener: (...args: any[]) => void][] = [
    ['close', (code: number) => this.mediaClosed(code)],
    ['stateChange', (_before: NetworkingState, after: NetworkingState) => this.mediaChanged(after)],
    ['error', (error: Error) => this.emitError(error)],
    ['debug', (message: string) => this.log?.(`[NW] ${message}`)],
    ['audio', (userId: string, samples: Int16Array) => this.receiver.onAudio(userId, samples)],
    ['participantLeave', (userId: string) => this.receiver.onParticipantLeave(userId)],
  ];

  /**
   * @param joinConfig - Where to connect and how
   * @param options - How to reach Bisim
   */
  public constructor(joinConfig: JoinConfig, options: CreateVoiceConnectionOptions) {
    super();
    this.joinConfig = joinConfig;
    this.log = options.debug ? (message) => this.emit('debug', message) : null;
    const implementer = options.adapterCreator({
      onVoiceServerUpdate: (data) => this.receiveDetails(data),
      onVoiceStateUpdate: (data) => this.receiveOwnState(data),
      destroy: () => {
        if (this.current.status !== S.Destroyed) this.destroy(false);
      },
    });
    this.current = { status: S.Signalling, adapter: implementer };
  }

  /**
   * The connection's state. Setting it cleans up what the old state held.
   */
  public get state(): VoiceConnectionState {
    return this.current;
  }

  public set state(next: VoiceConnectionState) {
    const before = this.current;
    const mediaBefore = networkingOf(before);
    const mediaAfter = networkingOf(next);
    const playerBefore = before.status === S.Destroyed ? undefined : before.subscription;
    const playerAfter = next.status === S.Destroyed ? undefined : next.subscription;

    if (mediaBefore && mediaBefore !== mediaAfter) this.release(mediaBefore);
    if (mediaAfter && mediaAfter !== mediaBefore) for (const [event, listener] of this.wiring) mediaAfter.on(event, listener);
    switch (next.status) {
      case S.Ready:
        this.rejoinAttempts = 0;
        break;
      case S.Disconnected:
        this.pendingChannel = null;
        break;
      case S.Destroyed:
        this.pendingChannel = null;
        this.receiver.close();
        this.decoder?.close();
        this.decoder = null;
        if (before.status !== S.Destroyed) before.adapter.destroy();
        break;
      default:
        break;
    }

    this.current = next;
    if (playerBefore !== undefined && playerBefore !== playerAfter) playerBefore.unsubscribe();

    this.emit('stateChange', before, next);
    if (before.status === next.status) return;
    this.emit(next.status, before, next as never);
    this.log?.(`state ${before.status} -> ${next.status}`);
  }

  /** Lets go of a media connection: it is closed, and anything it still says is ignored. */
  private release(media: Networking): void {
    for (const [event, listener] of this.wiring) media.off(event, listener);
    media.on('error', () => undefined);
    media.destroy();
    this.receiver.speaking.clear();
  }

  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else this.log?.(`error: ${error.message}`);
  }

  private live(): LiveState | null {
    return this.current.status === S.Destroyed ? null : this.current;
  }

  /**
   * The adapter's answer to a join: the media server and its token, or no endpoint when the join was refused.
   */
  private receiveDetails(details: BisimVoiceServerUpdateData): void {
    const state = this.live();
    if (!state) return;
    const waitingFor = this.pendingChannel;
    if (waitingFor === null || (details.channel_id && details.channel_id !== waitingFor)) {
      // Nothing was asked for (the bot left meanwhile), or this answers an older join a newer one replaced.
      this.log?.(`ignoring connection details for ${details.channel_id ?? 'a channel'} nobody waits for`);
      return;
    }
    this.pendingChannel = null;
    this.details = details;
    if (details.endpoint) {
      this.configureNetworking();
      return;
    }
    if (details.error) this.emitError(details.error);
    this.state = disconnectedFrom(state, Why.EndpointRemoved);
  }

  /**
   * The bot's own voice state, from the adapter.
   */
  private receiveOwnState(own: BisimVoiceStateUpdateData & { error?: Error }): void {
    if (!this.live()) return;
    const config = this.joinConfig;
    config.selfDeaf = own.self_deaf ?? config.selfDeaf;
    config.selfMute = own.self_mute ?? config.selfMute;
    this.serverMute = own.mute ?? this.serverMute;
    // A null channel does not by itself mean the bot should leave: a drop also reads like that. The media
    // connection closing says what happened.
    const media = networkingOf(this.current);
    if (own.channel_id && own.channel_id !== config.channelId) {
      // Moved by a moderator: the adapter is joining the new channel and its details follow. A refused move points
      // back at the channel the bot is still in.
      config.channelId = own.channel_id;
      this.pendingChannel = own.channel_id === media?.channelId ? null : own.channel_id;
    }
    if (own.error) this.emitError(own.error);
    if (media && media.channelId === config.channelId) this.applyFlags(media);
  }

  private applyFlags(media: Networking): void {
    media.setSelfDeaf(this.joinConfig.selfDeaf);
    media.setSelfMute(this.joinConfig.selfMute);
    media.setServerMute(this.serverMute);
  }

  /**
   * Connects to the media server with the newest details, replacing any connection there was. This happens by
   * itself when the details arrive, for example after a move to another channel.
   */
  public configureNetworking(): void {
    const state = this.live();
    const details = this.details;
    if (!state || !details?.endpoint) return;
    const channelId = details.channel_id ?? this.joinConfig.channelId;
    if (!channelId) return;
    const { guildId, selfDeaf, selfMute } = this.joinConfig;
    const media = new Networking(
      { endpoint: details.endpoint, token: details.token, guildId, channelId },
      { selfDeaf, selfMute, serverMute: this.serverMute, debug: this.log !== null },
    );
    this.state = { ...carry(state), status: S.Connecting, networking: media };
  }

  private mediaChanged(after: NetworkingState): void {
    const state = this.current;
    if (state.status !== S.Connecting && state.status !== S.Ready) return;
    if (after.code === NetworkingStatusCode.Ready) {
      if (state.status === S.Connecting) this.state = { ...state, status: S.Ready };
      this.sendFlagsChangedMeanwhile();
    } else if (after.code !== NetworkingStatusCode.Closed && state.status === S.Ready) {
      this.state = { ...state, status: S.Connecting };
    }
  }

  /** A mute or deafen changed while the join was on its way: the join carried the old one, so say it now. */
  private sendFlagsChangedMeanwhile(): void {
    const sent = this.joinedWith;
    this.joinedWith = null;
    const { selfMute, selfDeaf } = this.joinConfig;
    if (sent === null || (sent.selfMute === selfMute && sent.selfDeaf === selfDeaf)) return;
    this.live()?.adapter.sendPayload(createJoinVoiceChannelPayload(this.joinConfig));
  }

  private mediaClosed(code: number): void {
    const state = this.current;
    const media = networkingOf(state);
    if (!media || (state.status !== S.Connecting && state.status !== S.Ready)) return;
    if (media.channelId !== this.joinConfig.channelId) {
      // On the way to another channel: the server took the bot out of the old one. The new details follow.
      this.log?.(`left ${media.channelId} for ${this.joinConfig.channelId ?? 'nowhere'}`);
      this.state = signallingFrom(state);
      return;
    }
    const final = code === VoiceCloseCodes.Disconnected || code === VoiceCloseCodes.CallTerminated;
    if (final || !media.wasReady) {
      this.state = closedFrom(state, code);
      return;
    }
    // Dropped after being connected, and LiveKit could not get it back: join again with fresh details.
    this.state = signallingFrom(state);
    this.rejoinAttempts += 1;
    this.signal();
  }

  /**
   * Asks the adapter for a join to `joinConfig`'s channel and, unless Ready or already Signalling, goes Signalling.
   */
  private signal(): boolean {
    const state = this.live();
    if (!state) return false;
    this.pendingChannel = this.joinConfig.channelId;
    this.joinedWith = { selfMute: this.joinConfig.selfMute, selfDeaf: this.joinConfig.selfDeaf };
    if (!state.adapter.sendPayload(createJoinVoiceChannelPayload(this.joinConfig, true))) {
      this.state = disconnectedFrom(state, Why.AdapterUnavailable);
      return false;
    }
    // A synchronous adapter may have answered already.
    if (this.current === state && state.status !== S.Ready && state.status !== S.Signalling) this.state = signallingFrom(state);
    return true;
  }

  /**
   * Asks to be in a channel with a mute and deafen: a new join when the channel changes or the connection is not
   * connected, only the state when it stays where it is.
   *
   * @internal
   */
  public requestJoin(change: JoinChange, countAttempt: boolean): boolean {
    const state = this.live();
    if (!state) return false;
    const media = networkingOf(state);
    const where = media?.channelId ?? this.pendingChannel;
    Object.assign(this.joinConfig, change);
    const target = this.joinConfig.channelId;
    if (target === null) return false;
    const staying = target === where && (state.status === S.Ready || !countAttempt);
    if (!staying) {
      if (countAttempt && state.status !== S.Ready) this.rejoinAttempts += 1;
      return this.signal();
    }
    if (media) this.applyFlags(media);
    // Still on its way: a changed mute or deafen goes out once connected.
    if (state.status !== S.Ready || state.adapter.sendPayload(createJoinVoiceChannelPayload(this.joinConfig))) return true;
    this.state = disconnectedFrom(state, Why.AdapterUnavailable);
    return false;
  }

  /**
   * Joins again: after a disconnect, to another channel, or with another mute or deafen. Each call that is not made
   * while Ready counts as a rejoin attempt.
   *
   * @param joinConfig - What to change: `channelId`, `selfDeaf`, `selfMute`
   * @returns Whether the request went out
   */
  public rejoin(joinConfig?: JoinChange): boolean {
    return this.requestJoin(joinConfig ?? {}, true);
  }

  /**
   * Leaves the voice channel but keeps the connection, so {@link VoiceConnection.rejoin} can bring it back. The
   * player subscription ends.
   *
   * @returns Whether it disconnected
   */
  public disconnect(): boolean {
    const state = this.live();
    if (!state || state.status === S.Signalling) return false;
    const config = this.joinConfig;
    config.channelId = null;
    const sent = state.adapter.sendPayload(createJoinVoiceChannelPayload(this.joinConfig));
    this.state = sent ? { status: S.Disconnected, adapter: state.adapter, reason: Why.Manual } : disconnectedFrom(state, Why.AdapterUnavailable);
    return sent;
  }

  /**
   * Leaves voice and destroys the connection for good. Call it once you no longer need the connection.
   *
   * @param adapterAvailable - Whether to tell Bisim the bot left (default true)
   * @throws If it was already destroyed
   */
  public destroy(adapterAvailable = true): void {
    const state = this.live();
    if (!state) throw new Error('This VoiceConnection was already destroyed, it cannot be destroyed again');
    untrackVoiceConnection(this);
    if (adapterAvailable) state.adapter.sendPayload(createJoinVoiceChannelPayload({ ...this.joinConfig, channelId: null }));
    this.state = { status: S.Destroyed };
  }

  /**
   * Shows the bot as speaking, or not, to everyone in the call (the player does this by itself).
   *
   * @param enabled - Whether it speaks
   * @returns Whether the connection was ready to say so
   */
  public setSpeaking(enabled: boolean): boolean {
    if (this.current.status !== S.Ready) return false;
    this.current.networking.setSpeaking(enabled);
    return true;
  }

  /**
   * Plays an audio player on this connection, replacing the player it played before.
   *
   * @param player - The player
   * @returns The subscription, or `undefined` if the connection was destroyed
   */
  public subscribe(player: AudioPlayer): PlayerSubscription | undefined {
    const state = this.live();
    if (!state) return undefined;
    const link = (player as unknown as { subscribe(connection: VoiceConnection): PlayerSubscription }).subscribe(this);
    this.state = { ...state, subscription: link };
    return link;
  }

  /**
   * Sends one 20 ms frame of samples (the player calls this).
   *
   * @internal
   */
  public playFrame(frame: Buffer): boolean {
    return this.current.status === S.Ready && this.current.networking.sendFrame(frame);
  }

  /**
   * Decodes an Opus packet (20 ms, 48 kHz stereo) and keeps it for {@link VoiceConnection.dispatchAudio}.
   *
   * @param buffer - The Opus packet
   */
  public prepareAudioPacket(buffer: Buffer): Buffer | undefined {
    if (this.current.status !== S.Ready) return undefined;
    this.decoder ??= new OpusDecoder();
    this.prepared = this.decoder.decode(buffer);
    return this.prepared;
  }

  /**
   * Sends the packet {@link VoiceConnection.prepareAudioPacket} kept.
   *
   * @returns Whether there was one to send
   */
  public dispatchAudio(): boolean {
    const frame = this.prepared;
    this.prepared = null;
    return frame !== null && this.playFrame(frame);
  }

  /**
   * Decodes and sends one Opus packet at once (for relaying audio without a player).
   *
   * @param buffer - The Opus packet
   */
  public playOpusPacket(buffer: Buffer): boolean {
    return this.prepareAudioPacket(buffer) !== undefined && this.dispatchAudio();
  }

  /**
   * Accepted for compatibility: LiveKit does not report a ping here, so both are `undefined`.
   */
  public get ping(): { ws: number | undefined; udp: number | undefined } {
    return { ws: undefined, udp: undefined };
  }

  /**
   * Called when a player subscription ends.
   *
   * @internal
   */
  protected onSubscriptionRemoved(subscription: PlayerSubscription): void {
    const state = this.live();
    if (state?.subscription === subscription) this.state = { ...state, subscription: undefined };
  }
}

/**
 * Makes a connection, or reuses the one the server already has in that group.
 *
 * @param joinConfig - Where and how
 * @param options - How to reach Bisim
 * @internal
 */
export function createVoiceConnection(joinConfig: JoinConfig, options: CreateVoiceConnectionOptions): VoiceConnection {
  const known = getVoiceConnection(joinConfig.guildId, joinConfig.group);
  if (known !== undefined && known.state.status !== S.Destroyed) {
    const { channelId, selfDeaf, selfMute } = joinConfig;
    known.requestJoin({ channelId, selfDeaf, selfMute }, known.state.status === S.Disconnected);
    return known;
  }
  const connection = new VoiceConnection(joinConfig, options);
  trackVoiceConnection(connection);
  connection.requestJoin({}, false);
  return connection;
}
