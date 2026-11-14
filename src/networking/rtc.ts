/**
 * LiveKit's Node.js SDK, loaded the first time a connection needs it, so importing @bisim/voice does not load its
 * native module.
 *
 * @internal
 */
export type RtcModule = typeof import('@livekit/rtc-node');

let loading: Promise<RtcModule> | null = null;

/** @internal */
export function loadRtc(): Promise<RtcModule> {
  loading ??= import('@livekit/rtc-node').catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
