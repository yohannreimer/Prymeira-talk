const imageDataUrlPattern = /^data:image\/[a-z0-9.+-]+;base64,/i;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

export function getQrImageSrc(qrCode: string | null | undefined) {
  const value = qrCode?.trim();

  if (!value) {
    return null;
  }

  if (imageDataUrlPattern.test(value)) {
    return value;
  }

  if (value.startsWith("iVBORw0KGgo") && base64Pattern.test(value)) {
    return `data:image/png;base64,${value}`;
  }

  return null;
}
