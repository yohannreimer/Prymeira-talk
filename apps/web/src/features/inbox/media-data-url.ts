/** Private, bounded API media must respect production's data:-only local media policy. */
export async function mediaDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunking avoids overflowing the call stack for larger attachments.
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(chunks.join(''))}`;
}
