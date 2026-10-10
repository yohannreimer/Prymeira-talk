import { optimizePhoto } from '../src/features/inbox/photo-optimization';
import { compressPhoto } from '../src/features/inbox/photo-optimization-engine';
const out = document.querySelector<HTMLPreElement>('#results')!;
const results: Array<Record<string, unknown>> = [];
const assert = (condition: unknown, text: string) => { if (!condition) throw Error(text); };
function canvasBlob(canvas: HTMLCanvasElement, quality = 1) { return new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('encode')), 'image/jpeg', quality)); }
function canvas(width: number, height: number) {
  const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height); let seed = 123;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed >>> 24;
    img.data[i] = noise; img.data[i + 1] = (noise + Math.floor(i / 4 / width)) % 256; img.data[i + 2] = (noise + i / 4 % width) % 256; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0); return c;
}
async function check(name: string, run: () => Promise<Record<string, unknown>>) {
  const t = performance.now(); try { results.push({ name, passed: true, ...await run(), ms: Math.round(performance.now() - t) }); }
  catch (e) { results.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) }); }
  out.textContent = JSON.stringify(results, null, 2);
}
document.querySelector<HTMLButtonElement>('#run')!.onclick = async event => {
  (event.currentTarget as HTMLButtonElement).disabled = true;
  await check('JPEG grande: Worker, limite 2560, arquivo menor e saída válida', async () => {
    const c = canvas(4000, 3000), file = new File([await canvasBlob(c, 0.92)], 'fixture.jpg', { type: 'image/jpeg' }); c.width = c.height = 1;
    assert(file.size > 512 * 1024, 'Fixture too small');
    let responsiveTicks = 0; const interval = setInterval(() => responsiveTicks++, 16);
    const t = performance.now(); const result = await optimizePhoto(file); const ms = Math.round(performance.now() - t); clearInterval(interval);
    assert(responsiveTicks > 0, 'Main thread blocked');
    assert(result.reason === 'optimized', `Worker failed: ${result.reason}`);
    const bitmap = await createImageBitmap(result.file);
    assert(bitmap.width === 2560 && bitmap.height === 1920, 'Bad dimensions'); bitmap.close();
    assert(result.file.size < file.size * .95, 'No savings');
    const original = await optimizePhoto(file, true); assert(original.file === file, 'Original changed');
    return { inputBytes: file.size, outputBytes: result.file.size, compressionMs: ms, responsiveTicks, savingPercent: Math.round((1 - result.file.size / file.size) * 100) };
  });
  await check('EXIF orientação 6: retrato correto, sem recorte', async () => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 400; const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 300, 400); ctx.fillStyle = 'blue'; ctx.fillRect(300, 0, 300, 400);
    const b = new Uint8Array(await (await canvasBlob(c)).arrayBuffer());
    const exif = Uint8Array.from([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
    const oriented = new File([b.slice(0, 2), exif, b.slice(2)], 'oriented.jpg', { type: 'image/jpeg' });
    const blob = await compressPhoto(oriented); assert(blob, 'EXIF decode failed'); const bitmap = await createImageBitmap(blob!);
    assert(bitmap.width === 400 && bitmap.height === 600, 'Orientation lost');
    const target = new OffscreenCanvas(400, 600), pixels = target.getContext('2d')!; pixels.drawImage(bitmap, 0, 0); bitmap.close();
    const top = pixels.getImageData(200, 100, 1, 1).data, bottom = pixels.getImageData(200, 500, 1, 1).data;
    assert(top[0] > 200 && top[2] < 30 && bottom[2] > 200 && bottom[0] < 30, 'Wrong orientation/content');
    return { width: 400, height: 600 };
  });
  await check('PNG/GIF/WebP/PDF/áudio/vídeo preservados byte a byte', async () => {
    for (const type of ['image/png', 'image/gif', 'image/webp', 'application/pdf', 'audio/ogg', 'video/mp4']) {
      const f = new File([new Uint8Array(800_000)], 'fixture', { type }); assert((await optimizePhoto(f)).file === f, type+' changed');
    } return { preserved: 6 };
  });
  await check('JPEG inválido mantém original; Worker continua funcionando', async () => {
    const f = new File([new Uint8Array(800_000)], 'invalid.jpg', { type: 'image/jpeg' }); assert((await optimizePhoto(f)).file === f, 'Malformed input changed');
    const c = canvas(1600, 1200); const good = new File([await canvasBlob(c)], 'small-dimensions.jpg', { type: 'image/jpeg' }); c.width = c.height = 1;
    const result = await optimizePhoto(good); const b = await createImageBitmap(result.file); assert(b.width === 1600 && b.height === 1200, 'Upscaled'); b.close();
    return { malformedPreserved: true, noUpscale: true };
  });
  await check('Três JPEGs de cerca de 10 MB: preparo sequencial real', async () => {
    const c = canvas(3200, 2400), base = await canvasBlob(c); c.width = c.height = 1;
    // JPEG trailing padding is valid; simulates ~10 MB uploads without any client content.
    const padding = new Uint8Array(Math.max(0, 10 * 1024 * 1024 - base.size));
    let bytes = 0; const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const f = new File([base, padding], `batch-${i}.jpg`, { type: 'image/jpeg' });
      const t = performance.now(); const r = await optimizePhoto(f); times.push(Math.round(performance.now() - t));
      assert(r.reason === 'optimized', 'Batch preparation failed'); bytes += r.file.size;
    } return { inputBytes: 30 * 1024 * 1024, outputBytes: bytes, compressionMsPerFile: times };
  });
  document.querySelector('#summary')!.textContent = results.every(r => r.passed) ? `PASS ${results.length}/${results.length}` : `FAIL ${results.filter(r => !r.passed).length}`;
};
