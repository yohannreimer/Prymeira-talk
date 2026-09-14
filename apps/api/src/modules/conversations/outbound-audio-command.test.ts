import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const realRun = promisify(actual.execFile);
  const execFile = Object.assign(actual.execFile.bind(null), {
    [promisify.custom]: (file: string, args: string[], options: import('node:child_process').ExecFileOptions) => {
      calls.push({ file, args });
      return realRun(file, args, options);
    }
  });
  return { ...actual, execFile };
});
import { prepareVoiceRecording } from './outbound-audio.js';

describe('WhatsApp iPhone voice compatibility', () => {
  it('explicitly normalizes negative timestamps instead of relying on ffmpeg container defaults', async () => {
    // The real iPhone regression was verified with the user's short recording.
    // This contract check also covers platforms where a synthetic fixture starts at zero.
    await expect(prepareVoiceRecording('data:audio/ogg;base64,YQ==', 'audio/ogg')).rejects.toThrow();
    const encoding = calls.find(call => call.file === 'ffmpeg');
    expect(encoding).toBeDefined();
    const index = encoding!.args.indexOf('-avoid_negative_ts');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(encoding!.args[index + 1]).toBe('make_zero');
  });
});
