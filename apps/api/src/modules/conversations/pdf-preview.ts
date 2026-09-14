import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);

/** Raster previews work in webviews too; no PDF scripts, embedded links or remote assets run. */
export async function renderPdfPreview(bytes: Buffer, page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 2000 || bytes.length > 25 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('INVALID_PDF');
  const directory = await mkdtemp(join(tmpdir(), 'talk-pdf-preview-'));
  try {
    const source = join(directory, 'document.pdf');
    await writeFile(source, bytes);
    const info = await run('pdfinfo', [source], { timeout: 10000, maxBuffer: 64 * 1024 });
    const count = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
    if (!count || page > count) throw new Error('INVALID_PDF_PAGE');
    const prefix = join(directory, 'page');
    await run('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1600', '-png', source, prefix], { timeout: 20000, maxBuffer: 64 * 1024 });
    const file = `${prefix}.png`;
    if ((await stat(file)).size > 12 * 1024 * 1024) throw new Error('PDF_PREVIEW_TOO_LARGE');
    return { bytes: await readFile(file), mimeType: 'image/png', pageCount: count };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
