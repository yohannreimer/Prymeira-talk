import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function writeQualificationEvidence(kind: 'load' | 'upgrade', startedAt: string, metrics: Record<string, unknown>) {
  const root = resolve(process.cwd(), '../..');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  const directory = resolve(root, 'validation-artifacts'); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `qualification-${kind}.json`), JSON.stringify({ schemaVersion: 1, kind, sha,
    sourceState: dirty ? 'working-tree' : 'clean-checkout', runId: process.env.TALK_VALIDATION_RUN_ID ?? null,
    startedAt, completedAt: new Date().toISOString(), passed: true, testsExecuted: 1, metrics }, null, 2));
}
