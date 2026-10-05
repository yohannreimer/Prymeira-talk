import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Photo = { bytes: Buffer; mimeType: string };
export type StoredPhoto = Photo & { savedAt: number };
export type PhotoStore = {
  read(workspaceId: string, number: string): Promise<StoredPhoto | null>;
  write(workspaceId: string, number: string, photo: Photo): Promise<void>;
};

/**
 * WhatsApp profile pictures kept on the media volume, one file per workspace and number. A picture link from
 * WhatsApp expires and is only readable while a session is up; the saved copy keeps every avatar on screen when
 * a connection drops or reconnects, and is refreshed when the provider answers again.
 */
export function createPhotoStore(root: string): PhotoStore {
  const path = (workspaceId: string, number: string) => {
    const name = createHash('sha256').update(`${workspaceId}\u0000${number}`).digest('hex');
    return join(root, 'profile-photos', name.slice(0, 2), name);
  };
  return {
    async read(workspaceId, number) {
      const file = path(workspaceId, number);
      try {
        const [bytes, meta] = await Promise.all([readFile(file), readFile(`${file}.type`, 'utf8'), ]);
        const info = await stat(file);
        return bytes.length ? { bytes, mimeType: meta.trim() || 'image/jpeg', savedAt: info.mtimeMs } : null;
      } catch { return null; }
    },
    async write(workspaceId, number, photo) {
      const file = path(workspaceId, number);
      await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
      // Written aside and renamed: a reader never sees half a picture.
      await writeFile(`${file}.type.tmp`, photo.mimeType, { mode: 0o600 });
      await writeFile(`${file}.tmp`, photo.bytes, { mode: 0o600 });
      await rename(`${file}.type.tmp`, `${file}.type`);
      await rename(`${file}.tmp`, file);
    }
  };
}

let shared: PhotoStore | null | undefined;
/** The deployment's photo store, on the media volume (TALK_MEDIA_STORE_PATH); none without one. */
export function deploymentPhotoStore(): PhotoStore | null {
  if (shared === undefined) {
    const root = process.env.TALK_MEDIA_STORE_PATH?.trim();
    shared = root && root.startsWith('/') ? createPhotoStore(root) : null;
  }
  return shared;
}
