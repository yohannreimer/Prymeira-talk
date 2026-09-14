import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);
const MAX_BYTES = 8 * 1024 * 1024;
const formats: Record<string, string> = { 'audio/webm': 'matroska', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mp4': 'mov', 'audio/x-m4a': 'mov', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
export function decodeVoiceRecording(url: string, mimeType: string) {
  const mime = mimeType.split(';')[0].toLowerCase();
  const match = /^data:([^;,]+)(?:;codecs=[\w.-]+)?;base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!formats[mime] || !match || match[1].toLowerCase() !== mime || match[2].length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('Áudio inválido ou maior que 8 MB.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== match[2]) throw new Error('Áudio inválido ou maior que 8 MB.');
  return { bytes, demuxer: formats[mime] };
}
let activeConversions = 0;
export async function prepareVoiceRecording(url: string, mimeType: string) {
  const { bytes, demuxer } = decodeVoiceRecording(url, mimeType);
  if (activeConversions >= 2) throw new Error('Há outros áudios sendo preparados. Tente novamente em instantes.');
  activeConversions++;
  let directory: string | null = null;
  try {
    directory = await mkdtemp(join(tmpdir(), 'talk-outbound-voice-'));
    const source = join(directory, 'source'); const target = join(directory, 'voice.ogg');
    await writeFile(source, bytes);
    // Browser recordings can retain a negative start time after Opus conversion.
    // WhatsApp iOS then rejects an otherwise intact, downloadable voice message.
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', demuxer, '-i', source, '-vn', '-t', '301', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-avoid_negative_ts', 'make_zero', '-y', target], { timeout: 45000, maxBuffer: 64 * 1024 });
    const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', target], { timeout: 10000, maxBuffer: 4096 });
    const duration = Number(result.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0 || duration > 300.5) throw new Error('Grave um áudio de até 5 minutos.');
    const encoded = await readFile(target);
    if (encoded.length > MAX_BYTES) throw new Error('Áudio maior que 8 MB.');
    return { mediaUrl: `data:audio/ogg;base64,${encoded.toString('base64')}`, mimetype: 'audio/ogg', durationSeconds: duration };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Grave um')) throw e;
    throw new Error('Não foi possível preparar o áudio. Grave novamente.');
  } finally {
    activeConversions--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
