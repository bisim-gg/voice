import type { VoiceConnection } from '../VoiceConnection.js';
import type { AudioPlayer } from './AudioPlayer.js';

/**
 * The link between a connection and the player it plays, made by `connection.subscribe(player)`.
 */
export class PlayerSubscription {
  /** The connection. */
  public readonly connection: VoiceConnection;
  /** The player. */
  public readonly player: AudioPlayer;

  /**
   * @param connection - The connection
   * @param player - The player
   */
  public constructor(connection: VoiceConnection, player: AudioPlayer) {
    this.connection = connection;
    this.player = player;
  }

  /**
   * Stops the connection playing this player. The player keeps its state.
   */
  public unsubscribe(): void {
    (this.connection as unknown as { onSubscriptionRemoved(subscription: PlayerSubscription): void }).onSubscriptionRemoved(this);
    (this.player as unknown as { unsubscribe(subscription: PlayerSubscription): boolean }).unsubscribe(this);
  }
}
