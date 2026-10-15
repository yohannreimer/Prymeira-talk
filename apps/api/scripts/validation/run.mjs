import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { workspaceUnitCommand, databaseVariables, validateInfrastructure, findIntegrationTests, runSerialIntegration } from './validation.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const phase = process.argv[2] ?? 'all';
if (!['all', 'unit', 'build', 'prepare', 'integration'].includes(phase)) throw new Error('Expected all, unit, build, prepare or integration');
const output = join(root, 'validation-artifacts'); await mkdir(output, { recursive: true });
await rm(join(output, 'validation-all.json'), { force: true });
await rm(join(output, `validation-${phase}.json`), { force: true });
const run = (command, args, env = process.env, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' }); let text = '';
  if (capture) child.stdout.on('data', chunk => { text += chunk; });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve(text.trim()) : reject(new Error(`${command} exited ${code}`)));
});
const sha = await run('git', ['rev-parse', 'HEAD'], process.env, true);
const sourceState = (await run('git', ['status', '--porcelain'], process.env, true)) ? 'working-tree' : 'clean-checkout';
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) throw new Error('Checkout does not match GITHUB_SHA');
const unitEnv = { ...process.env };
for (const key of [...Object.keys(databaseVariables), 'INGRESS_TEST_AMQP_URL', 'TALK_TEST_POSTGRES_PORT', 'TALK_TEST_AMQP_PORT']) delete unitEnv[key];
const phases = [];
if (phase === 'all' || phase === 'unit') {
  await run('node', ['--test', 'apps/api/scripts/validation/validation.node-test.mjs'], unitEnv);
  await run('pnpm', ['-r', 'typecheck'], unitEnv);
  await run('pnpm', workspaceUnitCommand, unitEnv); phases.push('typecheck', 'unit');
}
if (phase === 'all' || phase === 'build') {
  await run('pnpm', ['--filter', '@prymeira-talk/api', 'build:prod'], unitEnv);
  await run('pnpm', ['--filter', '@prymeira-talk/web', 'build'], unitEnv); phases.push('api-build', 'web-build');
}
if (['all', 'prepare', 'integration'].includes(phase)) {
  const postgresPort = process.env.TALK_TEST_POSTGRES_PORT ?? '55439', amqpPort = process.env.TALK_TEST_AMQP_PORT ?? '56739';
  const infra = validateInfrastructure({ adminUrl: process.env.TALK_TEST_DATABASE_ADMIN_URL, brokerUrl: process.env.INGRESS_TEST_AMQP_URL, postgresPort, amqpPort });
  const integrationEnv = { ...unitEnv, TALK_TEST_POSTGRES_PORT: postgresPort, TALK_TEST_AMQP_PORT: amqpPort, INGRESS_TEST_AMQP_URL: infra.brokerUrl };
  for (const [key, database] of Object.entries(databaseVariables)) integrationEnv[key] = infra.urls[database];
  if (phase === 'all' || phase === 'prepare') {
    const admin = new Client({ connectionString: infra.adminUrl }); await admin.connect();
    try {
      for (const database of infra.databases) {
        if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount) await admin.query(`CREATE DATABASE "${database}"`);
      }
    } finally { await admin.end(); }
    for (const database of infra.databases) await run('pnpm', ['--filter', '@prymeira-talk/api', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { ...integrationEnv, DATABASE_URL: infra.urls[database] });
    phases.push('disposable-migrations');
  }
  if (phase === 'all' || phase === 'integration') {
    const tests = await findIntegrationTests(join(root, 'apps/api/src'));
    const reports = [], failures = [];
    await runSerialIntegration(tests, async file => {
      const name = relative(join(root, 'apps/api'), file), report = join(output, `${name.replaceAll('/', '_')}.json`);
      try {
      await run('pnpm', ['--filter', '@prymeira-talk/api', 'exec', 'vitest', 'run', name, '--maxWorkers=1', '--fileParallelism=false', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], integrationEnv);
      const result = JSON.parse(await readFile(report, 'utf8'));
      if (!result.numTotalTests || result.numFailedTests || result.numPendingTests) throw new Error(`${name}: integration gate requires executed passing tests without unexplained skips`);
      reports.push({ file: name, passed: result.numPassedTests });
      } catch (error) {
        if (process.env.TALK_VALIDATION_KEEP_GOING !== 'true') throw error;
        failures.push({ file: name, error: error.message });
        console.error(`INTEGRATION_FAILURE ${name}: ${error.message}`);
      }
    });
    await writeFile(join(output, 'integration-summary.json'), JSON.stringify({ sha, serial: true, reports, failures }, null, 2));
    if (failures.length) throw new Error(`${failures.length} integration suites failed; see integration-summary.json`);
    phases.push('postgres-rabbit-integration');
  }
}
await writeFile(join(output, `validation-${phase}.json`), JSON.stringify({ sha, sourceState, completedAt: new Date().toISOString(), phases }, null, 2));
console.log(`Validated ${sourceState} based on ${sha}: ${phases.join(', ')}`);
