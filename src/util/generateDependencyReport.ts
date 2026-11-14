import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { findFFmpeg } from '../audio/ffmpeg.js';
import { version } from '../version.js';

const load = createRequire(__filename);

function versionOf(name: string): string | null {
  try {
    return (load(`${name}/package.json`) as { version: string }).version;
  } catch {
    // Packages that do not export their package.json: walk up from the entry point.
  }
  try {
    let dir = dirname(load.resolve(name));
    for (let i = 0; i < 6; i++) {
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version ?? null;
      }
      dir = dirname(dir);
    }
  } catch {
    // Not installed.
  }
  return null;
}

function nativeLiveKit(): string {
  try {
    load('@livekit/rtc-ffi-bindings');
    return 'loads';
  } catch (error) {
    return `does not load (${(error as Error).message.split('\n')[0]})`;
  }
}

/**
 * A text report of what @bisim/voice runs on: its dependencies, LiveKit's native module and FFmpeg. Paste it into
 * an issue when asking for help.
 *
 * @example
 * ```js
 * console.log(generateDependencyReport());
 * ```
 */
export function generateDependencyReport(): string {
  const ffmpeg = findFFmpeg(true);
  const lines = [
    'Core',
    `- @bisim/voice: ${version}`,
    `- @livekit/rtc-node: ${versionOf('@livekit/rtc-node') ?? 'not found'}`,
    `- LiveKit native module (${process.platform}-${process.arch}): ${nativeLiveKit()}`,
    `- opusscript: ${versionOf('opusscript') ?? 'not found'}`,
    `- Node.js: ${process.versions.node}`,
    '',
    'FFmpeg (needed for files, URLs and anything that is not raw samples)',
    ffmpeg ? `- found: ${ffmpeg.command}` : '- not found: install it, add ffmpeg-static, or set FFMPEG_PATH',
    ...(ffmpeg ? [`- ${ffmpeg.version}`] : []),
    `- ffmpeg-static: ${versionOf('ffmpeg-static') ?? 'not installed'}`,
    '',
    'Optional',
    `- prism-media (decodes received Opus): ${versionOf('prism-media') ?? 'not installed'}`,
  ];
  const rule = '-'.repeat(50);
  return [rule, ...lines, rule].join('\n');
}
