import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { StreamType } from '../audio/StreamType.js';

/**
 * Whether an Opus identification header describes 48 kHz stereo audio, the format Bisim plays without
 * resampling.
 *
 * @param opusHead - The header, starting at `OpusHead`
 */
export function validateBisimOpusHead(opusHead: Buffer): boolean {
  if (opusHead.length < 16) return false;
  return opusHead.readUInt8(9) === 2 && opusHead.readUInt32LE(12) === 48_000;
}

/**
 * What {@link demuxProbe} found.
 */
export interface ProbeInfo {
  /** The stream, with the bytes the probe read put back in front. */
  stream: Readable;
  /** What it holds. */
  type: StreamType;
}

const OGG = Buffer.from('OggS');
const OPUS_HEAD = Buffer.from('OpusHead');
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const WEBM_OPUS = Buffer.from('A_OPUS');

function detect(head: Buffer, validator: (opusHead: Buffer) => boolean, final: boolean): StreamType | null {
  if (head.length < 4) return final ? StreamType.Arbitrary : null;
  const container = head.subarray(0, 4).equals(OGG) ? 'ogg' : head.subarray(0, 4).equals(EBML) ? 'webm' : null;
  if (!container) return StreamType.Arbitrary;
  const at = head.indexOf(OPUS_HEAD);
  if (at !== -1 && head.length >= at + 16) {
    const isOpus = container === 'ogg' || head.includes(WEBM_OPUS);
    if (!isOpus) return StreamType.Arbitrary;
    if (!validator(head.subarray(at))) return StreamType.Arbitrary;
    return container === 'ogg' ? StreamType.OggOpus : StreamType.WebmOpus;
  }
  // A WebM file names its codec before the header; anything but Opus can be decided at once.
  if (container === 'webm') {
    const codec = /A_[A-Z0-9/]{3,}/.exec(head.toString('latin1'));
    if (codec && codec[0] !== 'A_OPUS') return StreamType.Arbitrary;
  }
  if (container === 'ogg' && head.length >= 36 && at === -1) return StreamType.Arbitrary;
  return final ? StreamType.Arbitrary : null;
}

/**
 * Reads the start of a stream to tell what it holds, then gives it back unchanged. Pass the result straight to
 * {@link createAudioResource}.
 *
 * @example
 * ```js
 * const { stream, type } = await demuxProbe(createReadStream('./clip.ogg'));
 * player.play(createAudioResource(stream, { inputType: type }));
 * ```
 * @param stream - A byte stream
 * @param probeSize - How many bytes to read at most before deciding (default 1024)
 * @param validator - Checks an Opus header (default: 48 kHz stereo)
 */
export function demuxProbe(stream: Readable, probeSize = 1024, validator: (opusHead: Buffer) => boolean = validateBisimOpusHead): Promise<ProbeInfo> {
  return new Promise<ProbeInfo>((resolve, reject) => {
    const ended = stream.readableEnded || stream.destroyed;
    const refusal = stream.readableObjectMode ? 'Cannot probe a stream in object mode' : ended ? 'Cannot probe a stream that has already ended' : null;
    if (refusal) {
      reject(new Error(refusal));
      return;
    }
    let head = Buffer.alloc(0);
    let settled = false;
    const decide = (type: StreamType): void => {
      if (settled) return;
      settled = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.pause();
      if (stream.readableEnded) {
        resolve({ stream: Readable.from(head.length > 0 ? [head] : []), type });
        return;
      }
      if (head.length > 0) stream.unshift(head);
      resolve({ stream, type });
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const type = detect(head, validator, head.length >= probeSize);
      if (type) decide(type);
    };
    const onEnd = () => decide(detect(head, validator, true)!);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      reject(error);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}
