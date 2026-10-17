import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateInfrastructure, runSerialIntegration, releaseManifest, workspaceUnitCommand } from './validation.mjs';

const admin = 'postgresql://fixture:fixture@127.0.0.1:55439/postgres';
const broker = 'amqp://fixture:fixture@127.0.0.1:56739/talk_test';
const options = { adminUrl: admin, brokerUrl: broker, postgresPort: '55439', amqpPort: '56739' };

test('test harness rejects a remote host, a production DB and the shared Rabbit vhost before starting tests', () => {
  assert.throws(() => validateInfrastructure({ ...options, adminUrl: admin.replace('127.0.0.1', 'remote') }));
  assert.throws(() => validateInfrastructure({ ...options, adminUrl: admin.replace('/postgres', '/production') }));
  assert.throws(() => validateInfrastructure({ ...options, brokerUrl: broker.replace('/talk_test', '/') }));
  assert.throws(() => validateInfrastructure({ ...options, amqpPort: '5672' }));
  assert.equal(validateInfrastructure(options).databases.includes('talk_rehearsal'), true);
});

test('integration gate executes shared-fixture suites serially and stops on a failing suite', async () => {
  let active = 0, maximum = 0; const started = [];
  await assert.rejects(runSerialIntegration(['first', 'failing', 'must-not-run'], async file => {
    active++; maximum = Math.max(maximum, active); started.push(file);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (file === 'failing') throw new Error('test failure');
  }));
  assert.equal(maximum, 1); assert.deepEqual(started, ['first', 'failing']);
});

test('release manifest refuses to publish evidence from a different SHA or missing image digest', () => {
  const sha = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => releaseManifest({ sha, validatedSha: 'c'.repeat(40), apiDigest: digest, webDigest: digest }));
  assert.throws(() => releaseManifest({ sha, validatedSha: sha, apiDigest: '', webDigest: digest }));
  const manifest = releaseManifest({ sha, validatedSha: sha, apiDigest: digest, webDigest: digest });
  assert.equal(manifest.components.ingress.digest, digest); assert.equal(manifest.components.worker.digest, digest);
  assert.equal(manifest.validatedSha, sha);
});

test('image publication and release require a successful exact-revision validation job', async () => {
  const yaml = await readFile(new URL('../../../../.github/workflows/publish-images.yml', import.meta.url), 'utf8');
  assert.match(yaml, /publish:\s*\n\s+needs: validate/);
  assert.match(yaml, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(yaml, /node apps\/api\/scripts\/validation\/run\.mjs/);
  assert.doesNotMatch(yaml, /continue-on-error:\s*true/);
});


test('workspace unit command forwards Vitest options through real pnpm run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'talk-validation-cli-'));
  try {
    await mkdir(join(root, 'probe'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'validation-probe', private: true, packageManager: 'pnpm@10.0.0' }));
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - probe\n');
    await writeFile(join(root, 'probe/package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node probe.mjs' } }));
    await writeFile(join(root, 'probe/probe.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const result = spawnSync('pnpm', workspaceUnitCommand, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\["--maxWorkers=2"\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
