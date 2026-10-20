import fs from 'node:fs/promises';
import crypto from 'node:crypto';

interface Entry { file: string; bytes: number; touchedAt: number; }

export class CacheManager {
  private entries = new Map<string, Entry>();
  constructor(private readonly dir: string, private readonly maxBytes: number, private readonly ttlMs: number) {}
  async init(): Promise<void> { await fs.mkdir(this.dir, { recursive: true }); }
  pathFor(key: string): string { return `${this.dir}/${crypto.createHash('sha256').update(key).digest('hex')}.buffer`; }
  async touch(key: string, bytes: number): Promise<void> {
    this.entries.set(key, { file: this.pathFor(key), bytes, touchedAt: Date.now() });
    await this.cleanup();
  }
  async cleanup(): Promise<void> {
    const now = Date.now();
    const expired = [...this.entries.entries()].filter(([, entry]) => now - entry.touchedAt > this.ttlMs);
    for (const [key, entry] of expired) { await fs.rm(entry.file, { force: true }); this.entries.delete(key); }
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key, entry] of oldest) {
      if (total <= this.maxBytes) break;
      await fs.rm(entry.file, { force: true }); this.entries.delete(key); total -= entry.bytes;
    }
  }
  stats(): { entries: number; bytes: number } { return { entries: this.entries.size, bytes: [...this.entries.values()].reduce((s, e) => s + e.bytes, 0) }; }
}
