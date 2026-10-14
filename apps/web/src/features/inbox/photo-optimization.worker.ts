import { compressPhoto } from './photo-optimization-engine';

const scope = self as unknown as { onmessage: ((event: MessageEvent<File>) => void) | null; postMessage(value: { blob: Blob | null }): void };
scope.onmessage = async event => {
  try { scope.postMessage({ blob: await compressPhoto(event.data) }); }
  catch { scope.postMessage({ blob: null }); }
};
