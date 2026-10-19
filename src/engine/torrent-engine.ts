import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { FileManifest, Source, StreamHandle, StreamStatus, TorrentManifest } from '../types.js';
import { mimeType, randomId } from '../utils.js';
import { prioritizePieces } from './piece-prioritizer.js';
import { parseMagnet } from './metadata-resolver.js';

type WebTorrentFile = {
  name: string;
  path: string;
  length: number;
  offset?: number;
  createReadStream: (options?: { start?: number; end?: number }) => NodeJS.ReadableStream;
};

type WebTorrentTorrent = {
  infoHash: string;
  name: string;
  pieceLength: number;
  pieces: string[];
  files: WebTorrentFile[];
  downloaded: number;
  uploaded: number;
  numPeers: number;
  progress: number;
  select: (start: number, end: number, priority?: number) => void;
  deselect: (start: number, end: number, priority?: number) => void;
  destroy: (callback?: (error?: Error) => void) => void;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  off?: (event: string, listener: (...args: any[]) => void) => void;
};

type WebTorrentClient = {
  add: (source: unknown, callback?: (torrent: WebTorrentTorrent) => void) => WebTorrentTorrent;
  destroy: (callback?: (error?: Error) => void) => void;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  off?: (event: string, listener: (...args: any[]) => void) => void;
};

export interface TorrentEngineOptions {
  maxConcurrentTorrents?: number;
  idleTorrentGracePeriodMs?: number;
}

export class TorrentEngine extends EventEmitter {
  private manifests = new Map<string, TorrentManifest>();
  private streams = new Map<string, StreamStatus>();
  private torrents = new Map<string, WebTorrentTorrent>();
  private client?: WebTorrentClient;
  private clientPromise?: Promise<WebTorrentClient>;

  // Resource lifecycle tracking
  private torrentStreams = new Map<string, Set<string>>(); // infoHash -> Set<streamId>
  private pieceRefCounts = new Map<string, Map<number, number>>(); // infoHash -> Map<pieceIndex, count>
  private idleTimers = new Map<string, NodeJS.Timeout>(); // infoHash -> timeout
  private activeStreamHandles = new Map<string, { infoHash: string; fileIndex: number; pieces: number[] }>();

  public maxConcurrentTorrents: number;
  public idleTorrentGracePeriodMs: number;
  private isDestroyed = false;

  constructor(client?: WebTorrentClient, options: TorrentEngineOptions = {}) {
    super();
    this.client = client;
    this.maxConcurrentTorrents = Math.max(1, options.maxConcurrentTorrents ?? 4);
    this.idleTorrentGracePeriodMs = options.idleTorrentGracePeriodMs ?? 30_000;
  }

  private async getClient(): Promise<WebTorrentClient> {
    if (this.client) return this.client;
    this.clientPromise ??= import('webtorrent').then(({ default: WebTorrent }) => {
      this.client = new WebTorrent() as unknown as WebTorrentClient;
      return this.client;
    });
    return this.clientPromise;
  }

  async inspect(source: Source): Promise<TorrentManifest> {
    return this.registerManifest(source);
  }

  async registerManifest(source: Source): Promise<TorrentManifest> {
    if (this.isDestroyed) {
      throw new Error('TorrentEngine has been destroyed');
    }

    const client = await this.getClient();

    const torrentSource = 'torrentBuffer' in source ? source.torrentBuffer : source.magnet;
    let expectedHash: string | undefined;
    if ('magnet' in source) {
      try {
        expectedHash = parseMagnet(source.magnet).infoHash.toLowerCase();
      } catch {
        // Handled by webtorrent if custom parser fails
      }
    }

    if (expectedHash && this.manifests.has(expectedHash)) {
      this.cancelIdleCleanup(expectedHash);
      return this.manifests.get(expectedHash)!;
    }

    // Enforce MAX_CONCURRENT_TORRENTS capacity
    await this.enforceCapacity();

    return new Promise((resolve, reject) => {
      let settled = false;
      let activeTorrent: WebTorrentTorrent | undefined;

      const clientError = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        try {
          activeTorrent?.destroy();
        } catch {}
        finish(new Error('WebTorrent metadata timeout: no metadata received from the swarm'));
      }, 10000);

      const finish = (error?: Error, torrent?: WebTorrentTorrent) => {
        if (settled) return;
        clearTimeout(timer);
        client.off?.('error', clientError);

        if (error || !torrent) {
          settled = true;
          reject(error ?? new Error('WebTorrent did not return metadata'));
          return;
        }

        const infoHash = torrent.infoHash.toLowerCase();
        const files: FileManifest[] = torrent.files.map((file, index) => ({
          index,
          path: file.path || file.name,
          name: file.name,
          size: file.length,
          mimeType: mimeType(file.name),
          offset: torrent.files.slice(0, index).reduce((sum, item) => sum + item.length, 0),
          selected: false
        }));

        const manifest: TorrentManifest = {
          infoHash,
          name: torrent.name,
          pieceLength: torrent.pieceLength,
          pieceCount: torrent.pieces.length,
          files,
          totalSize: files.reduce((sum, file) => sum + file.size, 0)
        };

        this.manifests.set(infoHash, manifest);
        this.torrents.set(infoHash, torrent);
        if (!this.torrentStreams.has(infoHash)) {
          this.torrentStreams.set(infoHash, new Set());
        }
        this.cancelIdleCleanup(infoHash);
        settled = true;
        resolve(manifest);
      };

      try {
        client.on?.('error', clientError);
        activeTorrent = client.add(torrentSource, (ready) => finish(undefined, ready));
        activeTorrent?.on?.('error', (error) => finish(error));
        if (activeTorrent?.files?.length) {
          finish(undefined, activeTorrent);
        }
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  registerParsedManifest(manifest: TorrentManifest): void {
    const hash = manifest.infoHash.toLowerCase();
    if (this.manifests.has(hash)) {
      this.cancelIdleCleanup(hash);
      return;
    }
    this.enforceCapacitySync();
    this.manifests.set(hash, { ...manifest, infoHash: hash });
    if (!this.torrentStreams.has(hash)) {
      this.torrentStreams.set(hash, new Set());
    }
    this.cancelIdleCleanup(hash);
  }

  getManifest(infoHash: string): TorrentManifest | undefined {
    return this.manifests.get(infoHash.toLowerCase());
  }

  async destroyTorrent(infoHash: string): Promise<void> {
    const hash = infoHash.toLowerCase();
    this.cancelIdleCleanup(hash);

    const streamIds = this.torrentStreams.get(hash);
    if (streamIds) {
      for (const sid of [...streamIds]) {
        this.streams.delete(sid);
        this.activeStreamHandles.delete(sid);
      }
      this.torrentStreams.delete(hash);
    }

    this.pieceRefCounts.delete(hash);
    const torrent = this.torrents.get(hash);
    this.torrents.delete(hash);
    this.manifests.delete(hash);

    if (torrent) {
      await new Promise<void>((resolve) => {
        try {
          torrent.destroy(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  private destroyTorrentSync(infoHash: string): void {
    const hash = infoHash.toLowerCase();
    this.cancelIdleCleanup(hash);

    const streamIds = this.torrentStreams.get(hash);
    if (streamIds) {
      for (const sid of [...streamIds]) {
        this.streams.delete(sid);
        this.activeStreamHandles.delete(sid);
      }
      this.torrentStreams.delete(hash);
    }

    this.pieceRefCounts.delete(hash);
    const torrent = this.torrents.get(hash);
    this.torrents.delete(hash);
    this.manifests.delete(hash);

    if (torrent) {
      try {
        torrent.destroy();
      } catch {}
    }
  }

  async waitForPeers(infoHash: string, timeoutMs = 5000): Promise<void> {
    const torrent = this.torrents.get(infoHash.toLowerCase());
    if (!torrent) return;
    const deadline = Date.now() + timeoutMs;
    while (torrent.numPeers < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (torrent.numPeers < 1) {
      throw new Error('No active peers available');
    }
  }

  async verifyDataFlow(infoHash: string, fileIndex: number, timeoutMs = 5000): Promise<number> {
    const hash = infoHash.toLowerCase();
    const manifest = this.manifests.get(hash);
    const torrent = this.torrents.get(hash);
    const file = manifest?.files[fileIndex];
    const sourceFile = torrent?.files[fileIndex];
    if (!manifest || !torrent || !file || !sourceFile) {
      throw new Error('Torrent data flow is unavailable');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const stream = sourceFile.createReadStream({ start: 0, end: Math.min(file.size - 1, 64 * 1024 - 1) });
      const stoppable = stream as NodeJS.ReadableStream & { destroy?: () => void };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stoppable.destroy?.();
          reject(new Error('Torrent data flow timeout: no payload bytes received'));
        }
      }, timeoutMs);

      stream.on('data', (chunk: Buffer | Uint8Array) => {
        if (!settled && chunk.byteLength > 0) {
          settled = true;
          clearTimeout(timer);
          stoppable.destroy?.();
          resolve(chunk.byteLength);
        }
      });

      stream.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async openStream(infoHash: string, fileIndex: number): Promise<StreamHandle> {
    const hash = infoHash.toLowerCase();
    const manifest = this.manifests.get(hash);
    if (!manifest) throw new Error('Torrent metadata is not loaded');
    const file = manifest.files[fileIndex];
    if (!file) throw new Error('File index is out of range');

    this.cancelIdleCleanup(hash);

    const torrent = this.torrents.get(hash);
    const streamId = randomId('stream');
    const status: StreamStatus = {
      streamId,
      infoHash: hash,
      fileIndex,
      phase: 'buffering',
      progress: 0,
      downloaded: 0,
      uploaded: 0,
      peers: torrent?.numPeers ?? 0,
      bufferedBytes: 0,
      updatedAt: new Date().toISOString()
    };
    this.streams.set(streamId, status);

    let streamSet = this.torrentStreams.get(hash);
    if (!streamSet) {
      streamSet = new Set();
      this.torrentStreams.set(hash, streamSet);
    }
    streamSet.add(streamId);

    // Reference-aware piece selection
    const selectedPieces: number[] = [];
    if (torrent) {
      let refMap = this.pieceRefCounts.get(hash);
      if (!refMap) {
        refMap = new Map();
        this.pieceRefCounts.set(hash, refMap);
      }

      const fileStartPiece = Math.floor(file.offset / manifest.pieceLength);
      const fileEndPiece = Math.min(manifest.pieceCount - 1, Math.floor((file.offset + file.size - 1) / manifest.pieceLength));

      const priorityOrder = prioritizePieces(manifest.pieceCount, manifest.pieceLength, file.offset);
      for (const piece of priorityOrder) {
        if (piece >= fileStartPiece && piece <= fileEndPiece) {
          selectedPieces.push(piece);
          const currentCount = refMap.get(piece) ?? 0;
          if (currentCount === 0) {
            try {
              torrent.select(piece, piece, 10);
            } catch {}
          }
          refMap.set(piece, currentCount + 1);
        }
      }
    }

    this.activeStreamHandles.set(streamId, { infoHash: hash, fileIndex, pieces: selectedPieces });

    const sourceFile = torrent?.files[fileIndex];
    let isStreamDestroyed = false;

    return {
      streamId,
      infoHash: hash,
      file,
      size: file.size,
      createReadStream: (range) => sourceFile ? sourceFile.createReadStream(range) : this.createTestReadable(streamId, file, range),
      status: () => ({ ...this.streams.get(streamId)! }),
      destroy: async () => {
        if (isStreamDestroyed) return;
        isStreamDestroyed = true;
        this.cleanupStream(streamId);
      }
    };
  }

  private cleanupStream(streamId: string): void {
    this.streams.delete(streamId);
    const handleInfo = this.activeStreamHandles.get(streamId);
    if (!handleInfo) return;
    this.activeStreamHandles.delete(streamId);

    const { infoHash, pieces } = handleInfo;
    const streamSet = this.torrentStreams.get(infoHash);
    if (streamSet) {
      streamSet.delete(streamId);
    }

    // Release piece references
    const torrent = this.torrents.get(infoHash);
    const refMap = this.pieceRefCounts.get(infoHash);
    if (refMap && torrent) {
      for (const piece of pieces) {
        const count = (refMap.get(piece) ?? 1) - 1;
        if (count <= 0) {
          refMap.delete(piece);
          try {
            torrent.deselect(piece, piece, 0);
          } catch {}
        } else {
          refMap.set(piece, count);
        }
      }
    }

    // If no active streams remaining for this torrent, schedule grace period cleanup
    if (!streamSet || streamSet.size === 0) {
      this.scheduleIdleCleanup(infoHash);
    }

    this.emit('stream_destroyed', { streamId, infoHash });
  }

  private scheduleIdleCleanup(infoHash: string): void {
    this.cancelIdleCleanup(infoHash);
    if (this.idleTorrentGracePeriodMs <= 0) {
      this.destroyTorrent(infoHash).catch(() => {});
      return;
    }

    const timer = setTimeout(() => {
      this.idleTimers.delete(infoHash);
      const activeCount = this.torrentStreams.get(infoHash)?.size ?? 0;
      if (activeCount === 0) {
        this.destroyTorrent(infoHash).catch(() => {});
      }
    }, this.idleTorrentGracePeriodMs);

    this.idleTimers.set(infoHash, timer);
  }

  private cancelIdleCleanup(infoHash: string): void {
    const timer = this.idleTimers.get(infoHash);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(infoHash);
    }
  }

  private async enforceCapacity(): Promise<void> {
    if (this.manifests.size < this.maxConcurrentTorrents) {
      return;
    }

    for (const [hash] of this.manifests) {
      const activeStreams = this.torrentStreams.get(hash)?.size ?? 0;
      if (activeStreams === 0) {
        await this.destroyTorrent(hash);
        if (this.manifests.size < this.maxConcurrentTorrents) {
          return;
        }
      }
    }

    if (this.manifests.size >= this.maxConcurrentTorrents) {
      throw new Error(`Maximum concurrent torrents limit reached (${this.maxConcurrentTorrents})`);
    }
  }

  private enforceCapacitySync(): void {
    if (this.manifests.size < this.maxConcurrentTorrents) {
      return;
    }

    for (const [hash] of this.manifests) {
      const activeStreams = this.torrentStreams.get(hash)?.size ?? 0;
      if (activeStreams === 0) {
        this.destroyTorrentSync(hash);
        if (this.manifests.size < this.maxConcurrentTorrents) {
          return;
        }
      }
    }

    if (this.manifests.size >= this.maxConcurrentTorrents) {
      throw new Error(`Maximum concurrent torrents limit reached (${this.maxConcurrentTorrents})`);
    }
  }

  private createTestReadable(streamId: string, file: FileManifest, range?: { start: number; end: number }): NodeJS.ReadableStream {
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? file.size - 1, file.size - 1);
    const total = Math.max(0, end - start + 1);
    let sent = 0;
    let destroyed = false;

    const readable = new Readable({
      read: () => {
        if (destroyed) return;
        if (sent >= total) {
          readable.push(null);
          return;
        }
        const chunkSize = Math.min(64 * 1024, total - sent);
        const chunk = Buffer.alloc(chunkSize);
        sent += chunkSize;

        const status = this.streams.get(streamId);
        if (status) {
          status.phase = sent === total ? 'complete' : 'streaming';
          status.downloaded = sent;
          status.progress = total ? sent / total : 1;
          status.bufferedBytes = Math.max(0, total - sent);
          status.updatedAt = new Date().toISOString();
          this.emit('status', { ...status });
        }
        readable.push(chunk);
      },
      destroy: (err, callback) => {
        destroyed = true;
        callback(err);
      }
    });

    return readable;
  }

  getStatus(streamId: string): StreamStatus | undefined {
    return this.streams.get(streamId) ? { ...this.streams.get(streamId)! } : undefined;
  }

  getActiveStreamsCount(infoHash?: string): number {
    if (infoHash) {
      return this.torrentStreams.get(infoHash.toLowerCase())?.size ?? 0;
    }
    return this.streams.size;
  }

  getActiveTorrentsCount(): number {
    return this.manifests.size;
  }

  async destroy(): Promise<void> {
    this.isDestroyed = true;
    for (const [, timer] of this.idleTimers) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    for (const streamId of [...this.streams.keys()]) {
      this.cleanupStream(streamId);
    }

    this.activeStreamHandles.clear();
    this.streams.clear();
    this.torrentStreams.clear();
    this.pieceRefCounts.clear();

    const hashes = [...this.torrents.keys()];
    for (const hash of hashes) {
      await this.destroyTorrent(hash).catch(() => {});
    }

    this.manifests.clear();
    this.torrents.clear();
    this.removeAllListeners();
    if (this.client) {
      await new Promise<void>((resolve) => this.client!.destroy(() => resolve()));
    }
  }
}
