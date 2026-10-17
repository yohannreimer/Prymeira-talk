import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseManifest } from './validation.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)), output = join(root, 'validation-artifacts');
const validation = JSON.parse(await readFile(join(output, 'validation-all.json'), 'utf8'));
if (validation.sourceState !== 'clean-checkout') throw new Error('Release requires validation from a clean exact-SHA checkout');
for (const required of ['typecheck', 'unit', 'api-build', 'web-build', 'disposable-migrations', 'postgres-rabbit-integration'])
  if (!validation.phases.includes(required)) throw new Error(`Missing validation evidence: ${required}`);
const readDigest = async name => JSON.parse(await readFile(join(output, `image-${name}.json`), 'utf8'));
const [api, web] = await Promise.all([readDigest('api'), readDigest('web')]);
if (api.sha !== process.env.GITHUB_SHA || web.sha !== process.env.GITHUB_SHA) throw new Error('Image build revision mismatch');
const manifest = releaseManifest({ sha: process.env.GITHUB_SHA, validatedSha: validation.sha, apiDigest: api.digest, webDigest: web.digest, imageOwner: process.env.GITHUB_REPOSITORY_OWNER, registry: process.env.REGISTRY });
manifest.validation = validation;
manifest.migrations = [];
const migrations = join(root, 'apps/api/prisma/migrations');
for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const sql = await readFile(join(migrations, entry.name, 'migration.sql'));
  manifest.migrations.push({ name: entry.name, sha256: createHash('sha256').update(sql).digest('hex') });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Release manifest ready for ${manifest.sha}; deploy by immutable digest after environment verification.`);
