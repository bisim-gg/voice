import { EventEmitter } from 'node:events';

export interface SpeakingMap extends EventEmitter {
  /**
   * Someone started speaking.
   *
   * @eventProperty
   */
  on(event: 'start', listener: (userId: string) => void): this;
  /**
   * Someone stopped speaking.
   *
   * @eventProperty
   */
  on(event: 'end', listener: (userId: string) => void): this;
}

/**
 * Who is speaking in the call. A person starts speaking when their sound rises above a quiet level, and stops
 * {@link SpeakingMap.DELAY} milliseconds after it last did, so the short pauses inside speech do not count.
 */
export class SpeakingMap extends EventEmitter {
  /** How long a person stays speaking after their sound was last above the quiet level, in milliseconds. */
  public static readonly DELAY = 300;

  /** The people speaking now, with the time (milliseconds since the epoch) each one started. */
  public readonly users = new Map<string, number>();

  private readonly timers = new Map<string, NodeJS.Timeout>();

  /**
   * Marks a person as speaking now.
   *
   * @param userId - Who
   * @internal
   */
  public onPacket(userId: string): void {
    const timer = this.timers.get(userId);
    if (timer) clearTimeout(timer);
    else if (!this.users.has(userId)) {
      const since = Date.now();
      this.users.set(userId, since);
      this.emit('start', userId);
    }
    this.timers.set(
      userId,
      setTimeout(() => this.finish(userId), SpeakingMap.DELAY),
    );
  }

  /**
   * Ends a person's speaking at once (they left).
   *
   * @param userId - Who
   * @internal
   */
  public finish(userId: string): void {
    const timer = this.timers.get(userId);
    if (timer) clearTimeout(timer);
    this.timers.delete(userId);
    if (this.users.delete(userId)) this.emit('end', userId);
  }

  /** @internal */
  public clear(): void {
    for (const userId of [...this.users.keys()]) this.finish(userId);
  }
}
