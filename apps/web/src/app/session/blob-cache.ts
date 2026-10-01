export type BlobResource = { blob: Blob; url: string };
/** One in-memory byte budget shared by photos and attachments; no browser storage. */
export class SessionBlobCache {
  private entries = new Map<string, BlobResource>();
  private pending = new Map<string, Promise<BlobResource>>();
  private pins = new Map<string, number>();
  private bytes = 0;
  private generation = 0;
  constructor(readonly maxBytes = 64 * 1024 * 1024) {}

  get(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    return entry;
  }
  retain(key: string) { this.pins.set(key, (this.pins.get(key) ?? 0) + 1); }
  release(key: string) {
    const count = (this.pins.get(key) ?? 0) - 1;
    if (count > 0) this.pins.set(key, count); else this.pins.delete(key);
    this.trim();
  }
  async load(key: string, fetchBlob: () => Promise<Blob>): Promise<BlobResource> {
    const hit = this.get(key); if (hit) return hit;
    const inflight = this.pending.get(key); if (inflight) return inflight;
    const generation = this.generation;
    const job = fetchBlob().then(blob => {
      if (generation !== this.generation) throw new DOMException('Sessão encerrada.', 'AbortError');
      if (blob.size > this.maxBytes) throw new Error('Arquivo excede o limite de visualização de 64 MiB.');
      // Pins keep a displayed URL alive. If all resources are displayed, fail locally
      // instead of exceeding the session memory budget or revoking a playing resource.
      while (this.bytes + blob.size > this.maxBytes) {
        const oldest = [...this.entries.keys()].find(id => !this.pins.has(id));
        if (!oldest) throw new Error('Feche uma mídia aberta para carregar este arquivo.');
        this.remove(oldest);
      }
      const resource = { blob, url: URL.createObjectURL(blob) };
      this.entries.set(key, resource); this.bytes += blob.size;
      return resource;
    }).finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); });
    this.pending.set(key, job); return job;
  }
  remove(key: string) {
    const entry = this.entries.get(key); if (!entry) return;
    URL.revokeObjectURL(entry.url); this.bytes -= entry.blob.size; this.entries.delete(key);
  }
  private trim() {
    for (const key of this.entries.keys()) {
      if (this.bytes <= this.maxBytes) break;
      if (!this.pins.has(key)) this.remove(key);
    }
  }
  clear() {
    this.generation++;
    for (const key of this.entries.keys()) this.remove(key);
    this.pending.clear(); this.pins.clear();
  }
  get sizeBytes() { return this.bytes; }
}
