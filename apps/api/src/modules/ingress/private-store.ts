import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Owned immutable blobs, never exposed as static files. Raw signatures are verified
 * before this store is called. References are UUID names, not arbitrary paths. */
export class IngressPrivateStore {
  constructor(readonly root: string, readonly maxBytes = 32 * 1024 * 1024) {
    if (!isAbsolute(root)) throw new Error('Ingress storage requires an absolute private path');
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Ingress storage must be owned and private (0700)');
    if (await realpath(this.root) !== this.root) throw new Error('Ingress storage path must be canonical');
  }
  async put(bytes: Buffer) {
    if (bytes.length > this.maxBytes) throw new Error('Private ingress payload exceeds limit');
    const ref = `${randomUUID()}.blob`;
    const handle = await open(join(this.root, ref), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const dir = await open(this.root, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
    return { ref, digest: createHash('sha256').update(bytes).digest('hex') };
  }
  async read(ref: string, digest: string) {
    if (!/^[0-9a-f-]{36}\.blob$/.test(ref) || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid private ingress reference');
    const handle = await open(join(this.root, ref), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxBytes || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Invalid private ingress object');
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Private ingress integrity mismatch');
      return bytes;
    } finally { await handle.close(); }
  }
}
