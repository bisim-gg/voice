import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { PassThrough, type Readable } from 'node:stream';
import { CHANNELS, SAMPLE_RATE } from './pcm.js';

/**
 * Where FFmpeg was found, and its version line.
 */
export interface FFmpegInfo {
  /** The command or path that runs it. */
  command: string;
  /** The first line of `ffmpeg -version`. */
  version: string;
}

let found: FFmpegInfo | null | undefined;

function optionalRequire(name: string): unknown {
  try {
    const load = createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/`);
    return load(name);
  } catch {
    return null;
  }
}

function candidates(): string[] {
  const list: string[] = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);
  // The npm package ffmpeg-static exports the path of its binary.
  const bundled = optionalRequire('ffmpeg-static');
  if (typeof bundled === 'string') list.push(bundled);
  else if (bundled && typeof (bundled as { path?: unknown }).path === 'string') list.push((bundled as { path: string }).path);
  list.push('ffmpeg');
  return list;
}

/**
 * Finds FFmpeg: `FFMPEG_PATH`, then the `ffmpeg-static` package if installed, then `ffmpeg` on the PATH. The
 * answer is remembered; pass `true` to look again.
 *
 * @param refresh - Look again
 * @returns Where it is, or `null` when there is none
 */
export function findFFmpeg(refresh = false): FFmpegInfo | null {
  if (found !== undefined && !refresh) return found;
  found = null;
  for (const command of candidates()) {
    try {
      const result = spawnSync(command, ['-hide_banner', '-version'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
      if (result.status === 0 && typeof result.stdout === 'string') {
        found = { command, version: result.stdout.split(/\r?\n/)[0]!.trim() };
        break;
      }
    } catch {
      // Try the next one.
    }
  }
  return found;
}

/**
 * Starts FFmpeg turning `input` (a path, a URL, or a stream fed to its standard input) into 48 kHz stereo
 * signed 16-bit samples. The returned stream ends when FFmpeg is done; destroying it stops FFmpeg.
 *
 * @param input - What to read
 * @internal
 */
export function transcodeToPcm(input: string | Readable): Readable {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) {
    throw new Error('FFmpeg was not found. Install it (see generateDependencyReport()), add ffmpeg-static, or set FFMPEG_PATH.');
  }
  const remote = typeof input === 'string' && /^https?:\/\//i.test(input);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-analyzeduration',
    '0',
    ...(remote ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
    '-i',
    typeof input === 'string' ? input : 'pipe:0',
    '-vn',
    '-f',
    's16le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    String(CHANNELS),
    'pipe:1',
  ];
  const child: ChildProcessWithoutNullStreams = spawn(ffmpeg.command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = new PassThrough({ highWaterMark: 64 * 1024 });
  let stderr = '';
  let finished = false;
  const stop = () => {
    if (finished) return;
    finished = true;
    if (typeof input !== 'string') {
      input.unpipe(child.stdin);
      input.destroy();
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    if (stderr.length < 4_000) stderr += text;
  });
  child.stdin.on('error', () => {
    // FFmpeg closing its input early (it read enough, or was stopped) is not an error here.
  });
  child.stdout.pipe(output);
  child.once('error', (error) => {
    finished = true;
    output.destroy(error);
  });
  child.once('close', (code, signal) => {
    finished = true;
    if (code !== 0 && signal === null && !output.destroyed) {
      output.destroy(new Error(`FFmpeg stopped with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    }
  });
  output.once('close', stop);
  if (typeof input !== 'string') {
    input.once('error', (error) => output.destroy(error));
    input.pipe(child.stdin);
  }
  return output;
}
