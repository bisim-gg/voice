// An adapter like bisim.js's, recording what @bisim/voice asks and letting a test answer.
import type {
  BisimGatewayAdapterCreator,
  BisimGatewayAdapterLibraryMethods,
  BisimVoiceServerUpdateData,
  BisimVoiceStatePayload,
  BisimVoiceStateUpdateData,
} from '../../src/index.js';

export class FakeAdapter {
  public readonly payloads: BisimVoiceStatePayload[] = [];
  public methods: BisimGatewayAdapterLibraryMethods | null = null;
  public destroyed = 0;
  public available = true;
  /** Answer every join at once with an endpoint of this form (`null`: answer by hand). */
  public autoAnswer: ((channelId: string) => string) | null = (channelId) => `wss://lk.test/${channelId}`;

  public constructor(public readonly guildId = 'g1') {}

  public readonly creator: BisimGatewayAdapterCreator = (methods) => {
    this.methods = methods;
    return {
      sendPayload: (payload) => {
        if (!this.available) return false;
        this.payloads.push(payload);
        const { channel_id, connect, self_deaf, self_mute } = payload.d;
        if (channel_id && connect && this.autoAnswer) {
          const endpoint = this.autoAnswer(channel_id);
          queueMicrotask(() => {
            this.state({ channel_id, self_deaf, self_mute });
            this.server({ channel_id, endpoint, token: `token-${channel_id}` });
          });
        }
        return true;
      },
      destroy: () => {
        this.destroyed++;
      },
    };
  };

  public get last(): BisimVoiceStatePayload {
    return this.payloads[this.payloads.length - 1]!;
  }

  public state(data: Partial<BisimVoiceStateUpdateData> & { error?: Error }): void {
    this.methods!.onVoiceStateUpdate({ guild_id: this.guildId, user_id: 'bot', channel_id: null, ...data } as BisimVoiceStateUpdateData);
  }

  public server(data: Partial<BisimVoiceServerUpdateData>): void {
    this.methods!.onVoiceServerUpdate({ guild_id: this.guildId, token: '', endpoint: null, ...data });
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}
