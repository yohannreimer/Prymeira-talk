const imageDataUrlPattern = /^data:image\/[a-z0-9.+-]+;base64,/i;
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
