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

function assertWorkflowGate(yaml) {
  assert.match(yaml, /node apps\/api\/scripts\/validation\/run\.mjs/);
  assert.doesNotMatch(yaml, /continue-on-error:\s*true/);
  if (!/^name: Isolated messaging qualification \(no publication\)$/m.test(yaml)) {
    assert.match(yaml, /publish:\s*\n\s+needs: \[validate, provider-contract\]/);
    assert.match(yaml, /ref: \$\{\{ github\.sha \}\}/);
    return;
  }
  assert.match(yaml, /^name: Isolated messaging qualification \(no publication\)$/m);
  assert.match(yaml, /^on:\n  workflow_dispatch:\n    inputs:/m);
  assert.doesNotMatch(yaml, /^  (?:push|pull_request|schedule|workflow_call|workflow_run|release):/m);
  assert.match(yaml, /^permissions:\n  contents: read\n\n/m);
  assert.equal([...yaml.matchAll(/^\s*permissions:/gm)].length, 1);
  assert.deepEqual([...yaml.matchAll(/^  ([\w-]+):$/gm)].filter(match => ['validate', 'exact-images', 'publish', 'release', 'deploy'].includes(match[1])).map(match => match[1]), ['validate', 'exact-images']);
  const jobs = yaml.slice(yaml.indexOf('\njobs:\n'));
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]), ['validate', 'exact-images']);
  for (const [, action] of yaml.matchAll(/\buses:\s*(\S+)/g))
    assert.match(action, /^(?:actions\/(?:checkout|setup-node|upload-artifact)@v4|pnpm\/action-setup@v4)$/);
  assert.doesNotMatch(yaml, /\b(?:secrets|environment|write-all|id-token|packages):|\$\{\{\s*secrets\.|:\s*write\b|\b(?:docker\s+(?:push|login)|git\s+push|gh\s+(?:release|api)|ssh|scp|curl|wget)\b|--push\b|\bpush:\s*true|login-action|registry-auth|production_environment/i);
  assert.match(yaml, /candidate_sha:\n\s+description:[^\n]*\n\s+required: true/);
  assert.match(yaml, /full_gate:\n\s+type: boolean\n\s+description:[^\n]*\n\s+default: true/);
  assert.match(yaml, /^  CANDIDATE_SHA: \$\{\{ inputs\.candidate_sha \}\}$/m);
  assert.match(yaml, /validate:\n\s+if: \$\{\{ inputs\.full_gate \}\}/);
  const validation = jobs.slice(0, jobs.indexOf('\n  exact-images:'));
  assert.match(validation, /name: Checkout exact revision\n\s+uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(validation, /run: GITHUB_SHA="\$CANDIDATE_SHA" node apps\/api\/scripts\/validation\/run\.mjs/);
  assert.match(jobs, /test "\$\(git rev-parse HEAD\)" = "\$CANDIDATE_SHA"/);
}

test('workflow either gates publication on exact-revision validation or permits only isolated manual qualification', async () => {
  const yaml = await readFile(new URL('../../../../.github/workflows/publish-images.yml', import.meta.url), 'utf8');
  assertWorkflowGate(yaml);
});

test('workflow gate retains publishing requirements and rejects unsafe isolated hooks or mismatched validation', async () => {
  const publishing = 'jobs:\n  validate:\n    ref: ${{ github.sha }}\n    run: node apps/api/scripts/validation/run.mjs\n  publish:\n    needs: [validate, provider-contract]\n';
  assert.doesNotThrow(() => assertWorkflowGate(publishing));
  assert.throws(() => assertWorkflowGate(publishing.replace('[validate, provider-contract]', '[validate]')));
  assert.throws(() => assertWorkflowGate(publishing.replace('github.sha', 'github.ref')));
  const yaml = await readFile(new URL('../../../../.github/workflows/publish-images.yml', import.meta.url), 'utf8');
  if (/^name: Isolated messaging qualification \(no publication\)$/m.test(yaml)) {
    for (const suffix of ['\n  publish:\n    run: docker push example\n', '\n  publish:\n    needs: [validate, provider-contract]\n    ref: ${{ github.sha }}\n', '\n  release:\n    run: gh release create v1\n', '\n  external:\n    run: echo external\n', '\n    permissions:\n      contents: write\n', '\n    environment: production\n', '\n    run: docker login example\n', '\n    token: ${{ secrets.TOKEN }}\n'])
      assert.throws(() => assertWorkflowGate(yaml + suffix));
    for (const [before, after] of [['workflow_dispatch:', 'push:'], ['default: true', 'default: false'], ['GITHUB_SHA="$CANDIDATE_SHA"', 'GITHUB_SHA="different"'], ['ref: ${{ inputs.candidate_sha }}', 'ref: main']])
      assert.throws(() => assertWorkflowGate(yaml.replace(before, after)));
  }
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

test('qualification gate rejects reused SHA artifacts, working-tree evidence and skipped or empty reports', async () => {
  const { validateQualificationEvidence } = await import('./validation.mjs');
  const context = { kind: 'load', sha: 'a'.repeat(40), sourceState: 'clean-checkout', runId: 'this-run', startedAt: '2026-10-19T12:00:00Z', completedAt: '2026-10-19T12:01:00Z' };
  const metrics = { canonicalMessages: 80, dualProviderEnvelopes: 160, oracleIdentities: 83, canonicalAddresses: 2930, durationMs: 10_000, trafficDurationMs: 10_000,
    ingressP95Ms: 100, applicationP95Ms: 200, overlapEnvelopes: 20, overlapApplicationP95Ms: 250, restartDuplicatePreserved: true,
    recovery: { connections: 3, autonomousHistoricalEffects: 0, unexpectedFailures: 0, firstTurnAdvancedConnections: 0, firstTurnClaimedBackoffConnections: 2, untouchedConnectionsAfterContention: 1, observedContentionYields: 3, progressOrResumeProved: true, laterTurnRequired: true, laterTurnProgressProved: true, fixtureOnlyRescheduledNextAttempt: true, sweepMs: 1200, requestsPerConnection: [4,4,4] }, resources: { sampleCount: 40, durationMs: 9750, averageCpuPercent: 20, cpuWindowSeconds: 2, maximumRssKiB: 100_000 } };
  const report = { schemaVersion: 1, kind: 'load', sha: context.sha, sourceState: context.sourceState, runId: context.runId, startedAt: context.startedAt, completedAt: context.completedAt, passed: true, testsExecuted: 1, metrics };
  assert.equal(validateQualificationEvidence(report, context), report);
  const advanced = { ...report, metrics: { ...metrics, recovery: { ...metrics.recovery, firstTurnAdvancedConnections: 3, firstTurnClaimedBackoffConnections: 0, untouchedConnectionsAfterContention: 0,
    observedContentionYields: 0, laterTurnRequired: false, laterTurnProgressProved: null, fixtureOnlyRescheduledNextAttempt: false } } };
  assert.equal(validateQualificationEvidence(advanced, context), advanced);
  assert.throws(() => validateQualificationEvidence({ ...advanced, metrics: { ...advanced.metrics, recovery: { ...advanced.metrics.recovery, laterTurnProgressProved: true } } }, context));
  assert.throws(() => validateQualificationEvidence({ ...report, metrics: { ...metrics, recovery: { ...metrics.recovery, laterTurnProgressProved: null } } }, context));
  for (const bad of [null, { ...report, sha: 'b'.repeat(40) }, { ...report, runId: 'previous-run' }, { ...report, sourceState: 'working-tree' },
    { ...report, testsExecuted: 0 }, { ...report, passed: false }, { ...report, startedAt: '2026-10-18T12:00:00Z' }, { ...report, completedAt: 'invalid' }, { ...report, metrics: {} },
    { ...report, metrics: { ...metrics, resources: { maximumRssKiB: 100_000 } } }, { ...report, metrics: { ...metrics, oracleIdentities: 82 } }, { ...report, metrics: { ...metrics, applicationP95Ms: 2001 } },
    { ...report, metrics: { ...metrics, recovery: { ...metrics.recovery, requestsPerConnection: [5,4,4] } } }])
    assert.throws(() => validateQualificationEvidence(bad, context));
});

test('upgrade release gate requires preservation, validation and rollback compatibility evidence', async () => {
  const { validateQualificationEvidence } = await import('./validation.mjs');
  const context = { kind: 'upgrade', sha: 'a'.repeat(40), sourceState: 'clean-checkout', runId: 'upgrade-run', startedAt: '2026-10-19T12:00:00Z', completedAt: '2026-10-19T12:01:00Z' };
  const metrics = { baselineSha: '27fa3a06513d459e594f69c883fd777913764c5d', baselineMigrations: 82, candidateMigrations: 83, preservedCanonicalIdentities: 1, preservedReceiptBackedEffects: 10, preservedMedia: 1, invalidCoordinatesRejected: 7,
    checkpointPreserved: true, validatedConstraint: true, ledgerChecksumsVerified: true, lockTimeoutAtomicRollback: true, validationLockDmlCompatible: true, presentationObligationCompleted: true, oldWahaCursorRescannedOriginalCheckpoint: true, unchangedHandlers: ['effect-handlers.ts','effect-runner.ts'] };
  const report = { schemaVersion: 1, kind: 'upgrade', sha: context.sha, sourceState: context.sourceState, runId: context.runId, startedAt: context.startedAt, completedAt: context.completedAt, passed: true, testsExecuted: 1, metrics };
  assert.equal(validateQualificationEvidence(report, context), report);
  for (const key of ['checkpointPreserved','validatedConstraint','ledgerChecksumsVerified','lockTimeoutAtomicRollback','validationLockDmlCompatible','presentationObligationCompleted','oldWahaCursorRescannedOriginalCheckpoint'])
    assert.throws(() => validateQualificationEvidence({ ...report, metrics: { ...metrics, [key]: false } }, context));
  assert.throws(() => validateQualificationEvidence({ ...report, metrics: { ...metrics, baselineMigrations: 81 } }, context));
});

test('upgrade schema reset guard rejects another DB, port, host or unobserved ownership', async () => {
  const { assertOwnedUpgradeDatabase } = await import('./validation.mjs');
  const input = { databaseUrl: 'postgresql://fixture@127.0.0.1:55439/talk_upgrade_test', postgresPort: '55439', expectedDataDirectory: '/owned/fixture', actualDataDirectory: '/owned/fixture', actualDatabase: 'talk_upgrade_test' };
  assert.doesNotThrow(() => assertOwnedUpgradeDatabase(input));
  for (const bad of [{ ...input, databaseUrl: input.databaseUrl.replace('127.0.0.1','remote') }, { ...input, actualDatabase: 'messaging_test' },
    { ...input, databaseUrl: input.databaseUrl.replace('55439','5432') }, { ...input, expectedDataDirectory: '' }, { ...input, actualDataDirectory: '/production' }])
    assert.throws(() => assertOwnedUpgradeDatabase(bad));
});
