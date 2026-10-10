export const PHOTO_MAX_EDGE = 2560;
export const PHOTO_JPEG_QUALITY = 0.85;
const MAX_PHOTO_PIXELS = 60_000_000;

export function fittedPhotoSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('Invalid image dimensions');
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Read dimensions before allocating a decoded bitmap. Missing/oversized headers keep the original. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || marker === undefined) return null;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      const height = bytes[offset + 3] * 256 + bytes[offset + 4], width = bytes[offset + 5] * 256 + bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

export async function compressPhoto(file: File): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const header = jpegDimensions(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
  if (!header || header.width * header.height > MAX_PHOTO_PIXELS) return null;
  // Browser decode applies EXIF orientation. Size the canvas from the oriented bitmap, not its raw JPEG header.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    if (bitmap.width * bitmap.height > MAX_PHOTO_PIXELS) return null;
    const size = fittedPhotoSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: PHOTO_JPEG_QUALITY });
  } finally { bitmap.close(); }
}
