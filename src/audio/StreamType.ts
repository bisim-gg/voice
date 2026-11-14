/**
 * What an input stream holds, as {@link createAudioResource} and {@link demuxProbe} see it.
 *
 * Bisim's media is mixed and encoded by LiveKit, so @bisim/voice works with plain samples inside: anything
 * that is not {@link StreamType.Raw} is turned into samples first (FFmpeg for files, URLs and containers, a
 * built-in Opus decoder for bare Opus packets).
 */
export enum StreamType {
  /** Anything FFmpeg can read: mp3, wav, flac, m4a, a video file, a URL. */
  Arbitrary = 'arbitrary',
  /** An Ogg file holding Opus audio. */
  OggOpus = 'ogg/opus',
  /** A stream of bare Opus packets, one Buffer each (an object mode stream), 48 kHz stereo. */
  Opus = 'opus',
  /** Signed 16-bit little-endian samples, 48 kHz, two channels: played as they are. */
  Raw = 'raw',
  /** A WebM file holding Opus audio. */
  WebmOpus = 'webm/opus',
}
