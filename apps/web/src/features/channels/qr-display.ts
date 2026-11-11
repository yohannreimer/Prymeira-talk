import jsQR from 'jsqr';

const imageDataUrlPattern = /^data:image\/(?:png|jpeg|webp);base64,/i;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

export type QrDisplaySource =
  | {
      kind: "image";
      src: string;
    }
  | {
      kind: "payload";
      payload: string;
    };

export function getQrDisplaySource(qrCode: string | null | undefined): QrDisplaySource | null {
  const value = qrCode?.trim();

  if (!value) {
    return null;
  }

  if (imageDataUrlPattern.test(value)) {
    return {
      kind: "image",
      src: value
    };
  }

  if (value.startsWith("iVBORw0KGgo") && base64Pattern.test(value)) {
    return {
      kind: "image",
      src: `data:image/png;base64,${value}`
    };
  }

  return {
    kind: "payload",
    payload: value
  };
}

export function getQrImageSrc(qrCode: string | null | undefined) {
  const source = getQrDisplaySource(qrCode);

  return source?.kind === "image" ? source.src : null;
}

/** WhatsApp pairing: reference + three 32-byte keys, optionally a platform ID.
 * This recognizes pairing content; only the connection event confirms login. */
export function isWhatsappPairingQr(value: string): boolean {
  const prefix = 'https://wa.me/settings/linked_devices#';
  const parts = (value.startsWith(prefix) ? value.slice(prefix.length) : value).split(',');
  return (parts.length === 4 || parts.length === 5)
    && /^[A-Za-z0-9+/_=@.-]{16,1024}$/.test(parts[0]!)
    && parts.slice(1, 4).every((part) => /^[A-Za-z0-9+/]{43}=$/.test(part))
    && (parts.length === 4 || /^\d{1,3}$/.test(parts[4]!));
}

export function decodePairingQrPixels(data: Uint8ClampedArray, width: number, height: number): string | null {
  if (width < 1 || height < 1 || width * height > 4_194_304 || data.length !== width * height * 4) return null;
  const result = jsQR(data, width, height);
  return result && isWhatsappPairingQr(result.data) ? result.data : null;
}

/** Never show provider images before decoding them. Bound time and allocation. */
export async function readPairingQr(qrCode: string | null | undefined, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted || !qrCode || qrCode.length > 2_000_000) return null;
  const source = getQrDisplaySource(qrCode);
  if (!source) return null;
  if (source.kind === 'payload') return isWhatsappPairingQr(source.payload) ? source.payload : null;
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (value: string | null) => {
      window.clearTimeout(timer);
      image.onload = image.onerror = null;
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish(null);
    const timer = window.setTimeout(abort, 3_000);
    signal?.addEventListener('abort', abort, { once: true });
    image.onerror = abort;
    image.onload = () => {
      try {
        const width = image.naturalWidth, height = image.naturalHeight;
        if (!width || !height || width * height > 4_194_304) return finish(null);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return finish(null);
        context.drawImage(image, 0, 0);
        finish(decodePairingQrPixels(context.getImageData(0, 0, width, height).data, width, height));
      } catch { finish(null); }
    };
    image.src = source.src;
  });
}
