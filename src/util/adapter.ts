/**
 * What the adapter hands to {@link BisimGatewayAdapterLibraryMethods.onVoiceServerUpdate}: where the media
 * server is and the pass to enter it. On Bisim this is the answer to a voice join: `endpoint` is the
 * LiveKit signaling URL and `token` the LiveKit access token.
 */
export interface BisimVoiceServerUpdateData {
  /** The server the voice channel belongs to. */
  guild_id: string;
  /** The access token for the media server. Empty when `endpoint` is `null`. */
  token: string;
  /** The media server's address, or `null` when there is none to connect to (the join was refused). */
  endpoint: string | null;
  /** The channel the token is for (Bisim). */
  channel_id?: string | null;
  /** Whether the bot may send sound in that channel (Bisim). */
  can_publish?: boolean;
  /** Why there is no endpoint, when the adapter knows (Bisim). */
  error?: Error;
}

/**
 * What the adapter hands to {@link BisimGatewayAdapterLibraryMethods.onVoiceStateUpdate}: the bot's own voice
 * state, with Discord's field names.
 */
export interface BisimVoiceStateUpdateData {
  /** The server. */
  guild_id: string;
  /** The voice channel the bot is in, or `null` once it left. */
  channel_id: string | null;
  /** The bot's user id. */
  user_id: string;
  /** Always an empty string on Bisim (there are no voice sessions to name). */
  session_id?: string;
  /** Whether a moderator muted the bot. */
  mute?: boolean;
  /** Whether a moderator deafened the bot. */
  deaf?: boolean;
  /** Whether the bot muted itself. */
  self_mute?: boolean;
  /** Whether the bot deafened itself. */
  self_deaf?: boolean;
  /** Always `false`: a bot sends no video on Bisim. */
  self_video?: boolean;
  /** Always `false`: a bot does not share a screen on Bisim. */
  self_stream?: boolean;
  /** Always `false` (Bisim has no stage channels). */
  suppress?: boolean;
  /** Always `null` (Bisim has no stage channels). */
  request_to_speak_timestamp?: string | null;
}

/**
 * The voice state request @bisim/voice sends through {@link BisimGatewayAdapterImplementerMethods.sendPayload},
 * shaped like Discord's gateway opcode 4.
 */
export interface BisimVoiceStatePayload {
  /** Always 4, Discord's Voice State Update opcode. */
  op: 4;
  d: {
    /** The server. */
    guild_id: string;
    /** The voice channel to be in, or `null` to leave voice. */
    channel_id: string | null;
    /** Whether to be muted. */
    self_mute: boolean;
    /** Whether to be deafened. */
    self_deaf: boolean;
    /**
     * Bisim: `true` when the connection needs fresh connection details even if it asks for the channel it is
     * already in (a rejoin after a drop). The adapter then joins again instead of only updating the state.
     */
    connect?: boolean;
  };
}

/**
 * The methods @bisim/voice gives an adapter, so the adapter can pass on what the server says.
 */
export interface BisimGatewayAdapterLibraryMethods {
  /**
   * Call this when the adapter can no longer be used (the client was destroyed, or left the server).
   */
  destroy(): void;
  /**
   * Call this with the answer to a voice join: where to connect and the token for it.
   *
   * @param data - The media server and token
   */
  onVoiceServerUpdate(data: BisimVoiceServerUpdateData): void;
  /**
   * Call this with the bot's own voice state in this server.
   *
   * @param data - The voice state
   */
  onVoiceStateUpdate(data: BisimVoiceStateUpdateData): void;
}

/**
 * The methods an adapter gives @bisim/voice.
 */
export interface BisimGatewayAdapterImplementerMethods {
  /**
   * Called by @bisim/voice once the connection is gone and the adapter can be cleaned up.
   */
  destroy(): void;
  /**
   * Called by @bisim/voice to join, leave, or change the bot's own mute and deafen. On Bisim the adapter does
   * this over the REST API and answers through the library methods.
   *
   * @param payload - The request, shaped like Discord's opcode 4
   * @returns `false` when the request certainly could not be sent; the connection then disconnects
   */
  sendPayload(payload: BisimVoiceStatePayload): boolean;
}

/**
 * Builds an adapter. bisim.js gives one for every server as `guild.voiceAdapterCreator`, so you rarely write one
 * yourself.
 */
export type BisimGatewayAdapterCreator = (methods: BisimGatewayAdapterLibraryMethods) => BisimGatewayAdapterImplementerMethods;
