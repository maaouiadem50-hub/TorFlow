// src/server.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";

// src/config.ts
import "dotenv/config";
import path from "node:path";
function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
function loadConfig(env = process.env) {
  const origins = env.ALLOWED_ORIGINS ?? env.CORS_ORIGIN ?? "";
  const isVercel = env.VERCEL === "1" || env.VERCEL === "true";
  return {
    host: env.HOST || "0.0.0.0",
    port: boundedNumber(env.PORT, 8080, 1, 65535),
    nodeEnv: env.NODE_ENV || (isVercel ? "production" : "development"),
    cacheDir: path.resolve(env.CACHE_DIR || (isVercel ? "/tmp/torflow-cache" : ".cache")),
    cacheMaxBytes: boundedNumber(env.CACHE_MAX_BYTES, 2147483648, 1048576, 2e10),
    cacheTtlSeconds: boundedNumber(env.CACHE_TTL_SECONDS, 3600, 60, 86400),
    maxConcurrentTorrents: boundedNumber(env.MAX_CONCURRENT_TORRENTS, 4, 1, 100),
    allowedOrigins: origins.split(",").map((origin) => origin.trim()).filter(Boolean),
    indexerUrl: env.INDEXER_URL,
    indexerApiKey: env.INDEXER_API_KEY,
    resolverTimeoutMs: boundedNumber(env.RESOLVER_TIMEOUT_MS, 45e3, 500, 45e3),
    openSubtitlesApiKey: env.OPENSUBTITLES_API_KEY,
    resolutionCacheEnabled: env.RESOLUTION_CACHE_ENABLED !== "false",
    resolutionCacheTtlSeconds: boundedNumber(env.RESOLUTION_CACHE_TTL_SECONDS, 3600, 60, 7200),
    resolutionCacheMaxEntries: boundedNumber(env.RESOLUTION_CACHE_MAX_ENTRIES, 500, 1, 5e4),
    resolverDebug: env.RESOLVER_DEBUG === "true" && env.NODE_ENV !== "production",
    apiKey: env.TORFLOW_API_KEY || void 0,
    adminKey: env.TORFLOW_ADMIN_KEY || env.TORFLOW_API_KEY || void 0,
    rateLimitWindowMs: boundedNumber(env.RATE_LIMIT_WINDOW_MS, 6e4, 1e3, 36e5),
    rateLimitMax: boundedNumber(env.RATE_LIMIT_MAX, 60, 1, 1e5)
  };
}

// src/engine/cache-manager.ts
import fs from "node:fs/promises";
import crypto from "node:crypto";
var CacheManager = class {
  constructor(dir, maxBytes, ttlMs) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
  }
  dir;
  maxBytes;
  ttlMs;
  entries = /* @__PURE__ */ new Map();
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }
  pathFor(key) {
    return `${this.dir}/${crypto.createHash("sha256").update(key).digest("hex")}.buffer`;
  }
  async touch(key, bytes) {
    this.entries.set(key, { file: this.pathFor(key), bytes, touchedAt: Date.now() });
    await this.cleanup();
  }
  async cleanup() {
    const now = Date.now();
    const expired = [...this.entries.entries()].filter(([, entry]) => now - entry.touchedAt > this.ttlMs);
    for (const [key, entry] of expired) {
      await fs.rm(entry.file, { force: true });
      this.entries.delete(key);
    }
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key, entry] of oldest) {
      if (total <= this.maxBytes) break;
      await fs.rm(entry.file, { force: true });
      this.entries.delete(key);
      total -= entry.bytes;
    }
  }
  stats() {
    return { entries: this.entries.size, bytes: [...this.entries.values()].reduce((s, e) => s + e.bytes, 0) };
  }
};

// src/engine/torrent-engine.ts
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// src/utils.ts
import crypto2 from "node:crypto";
import path2 from "node:path";
var MIME = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".alac": "audio/alac",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t"
};
function mimeType(filePath) {
  return MIME[path2.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
function randomId(prefix) {
  return `${prefix}_${crypto2.randomBytes(9).toString("base64url")}`;
}

// src/engine/piece-prioritizer.ts
function prioritizePieces(pieceCount, pieceLength, startOffset = 0, options = {}) {
  const lookAhead = options.lookAhead ?? 32;
  const headerPieces = Math.min(options.headerPieces ?? 2, pieceCount);
  const start = Math.max(0, Math.min(pieceCount - 1, Math.floor(startOffset / pieceLength)));
  const ordered = [];
  const add = (piece) => {
    if (piece >= 0 && piece < pieceCount && !ordered.includes(piece)) ordered.push(piece);
  };
  for (let i = 0; i < headerPieces; i++) add(i);
  for (let i = start; i < Math.min(pieceCount, start + lookAhead); i++) add(i);
  for (let i = 0; i < pieceCount; i++) add(i);
  return ordered;
}

// src/engine/metadata-resolver.ts
import bencode from "bencode";
function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let current = 0;
  const bytes = [];
  for (const character of value.toUpperCase().replace(/=+$/, "")) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base32 info hash");
    current = current << 5 | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(current >> bits & 255);
    }
  }
  return Buffer.from(bytes);
}
function parseMagnet(magnet2) {
  if (!magnet2.startsWith("magnet:?")) throw new Error("Invalid magnet URI");
  const params = new URL(magnet2).searchParams;
  const xt = params.get("xt") ?? "";
  const match = xt.match(/^urn:btih:([a-zA-Z0-9]+)$/);
  if (!match) throw new Error("Magnet URI must include an urn:btih identifier");
  const raw = match[1] ?? "";
  if (/^0+$/.test(raw)) throw new Error("Invalid magnet info hash");
  const infoHash = /^[a-fA-F0-9]{40}$/.test(raw) ? raw.toLowerCase() : decodeBase32(raw).toString("hex");
  return { infoHash, name: params.get("dn") ?? void 0 };
}

// src/engine/torrent-engine.ts
var TorrentEngine = class extends EventEmitter {
  manifests = /* @__PURE__ */ new Map();
  streams = /* @__PURE__ */ new Map();
  torrents = /* @__PURE__ */ new Map();
  client;
  clientPromise;
  // Resource lifecycle tracking
  torrentStreams = /* @__PURE__ */ new Map();
  // infoHash -> Set<streamId>
  pieceRefCounts = /* @__PURE__ */ new Map();
  // infoHash -> Map<pieceIndex, count>
  idleTimers = /* @__PURE__ */ new Map();
  // infoHash -> timeout
  activeStreamHandles = /* @__PURE__ */ new Map();
  maxConcurrentTorrents;
  idleTorrentGracePeriodMs;
  isDestroyed = false;
  constructor(client, options = {}) {
    super();
    this.client = client;
    this.maxConcurrentTorrents = Math.max(1, options.maxConcurrentTorrents ?? 4);
    this.idleTorrentGracePeriodMs = options.idleTorrentGracePeriodMs ?? 3e4;
  }
  async getClient() {
    if (this.client) return this.client;
    this.clientPromise ??= import("webtorrent").then(({ default: WebTorrent }) => {
      this.client = new WebTorrent();
      return this.client;
    });
    return this.clientPromise;
  }
  async inspect(source) {
    return this.registerManifest(source);
  }
  async registerManifest(source) {
    if (this.isDestroyed) {
      throw new Error("TorrentEngine has been destroyed");
    }
    const client = await this.getClient();
    const torrentSource = "torrentBuffer" in source ? source.torrentBuffer : source.magnet;
    let expectedHash;
    if ("magnet" in source) {
      try {
        expectedHash = parseMagnet(source.magnet).infoHash.toLowerCase();
      } catch {
      }
    }
    if (expectedHash && this.manifests.has(expectedHash)) {
      this.cancelIdleCleanup(expectedHash);
      return this.manifests.get(expectedHash);
    }
    await this.enforceCapacity();
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeTorrent;
      const clientError = (error) => finish(error);
      const timer = setTimeout(() => {
        try {
          activeTorrent?.destroy();
        } catch {
        }
        finish(new Error("WebTorrent metadata timeout: no metadata received from the swarm"));
      }, 1e4);
      const finish = (error, torrent) => {
        if (settled) return;
        clearTimeout(timer);
        client.off?.("error", clientError);
        if (error || !torrent) {
          settled = true;
          reject(error ?? new Error("WebTorrent did not return metadata"));
          return;
        }
        const infoHash = torrent.infoHash.toLowerCase();
        const files = torrent.files.map((file, index) => ({
          index,
          path: file.path || file.name,
          name: file.name,
          size: file.length,
          mimeType: mimeType(file.name),
          offset: torrent.files.slice(0, index).reduce((sum, item) => sum + item.length, 0),
          selected: false
        }));
        const manifest = {
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
          this.torrentStreams.set(infoHash, /* @__PURE__ */ new Set());
        }
        this.cancelIdleCleanup(infoHash);
        settled = true;
        resolve(manifest);
      };
      try {
        client.on?.("error", clientError);
        activeTorrent = client.add(torrentSource, (ready) => finish(void 0, ready));
        activeTorrent?.on?.("error", (error) => finish(error));
        if (activeTorrent?.files?.length) {
          finish(void 0, activeTorrent);
        }
      } catch (error) {
        finish(error);
      }
    });
  }
  registerParsedManifest(manifest) {
    const hash = manifest.infoHash.toLowerCase();
    if (this.manifests.has(hash)) {
      this.cancelIdleCleanup(hash);
      return;
    }
    this.enforceCapacitySync();
    this.manifests.set(hash, { ...manifest, infoHash: hash });
    if (!this.torrentStreams.has(hash)) {
      this.torrentStreams.set(hash, /* @__PURE__ */ new Set());
    }
    this.cancelIdleCleanup(hash);
  }
  getManifest(infoHash) {
    return this.manifests.get(infoHash.toLowerCase());
  }
  async destroyTorrent(infoHash) {
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
      await new Promise((resolve) => {
        try {
          torrent.destroy(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }
  destroyTorrentSync(infoHash) {
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
      } catch {
      }
    }
  }
  async waitForPeers(infoHash, timeoutMs = 5e3) {
    const torrent = this.torrents.get(infoHash.toLowerCase());
    if (!torrent) return;
    const deadline = Date.now() + timeoutMs;
    while (torrent.numPeers < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (torrent.numPeers < 1) {
      throw new Error("No active peers available");
    }
  }
  async verifyDataFlow(infoHash, fileIndex, timeoutMs = 5e3) {
    const hash = infoHash.toLowerCase();
    const manifest = this.manifests.get(hash);
    const torrent = this.torrents.get(hash);
    const file = manifest?.files[fileIndex];
    const sourceFile = torrent?.files[fileIndex];
    if (!manifest || !torrent || !file || !sourceFile) {
      throw new Error("Torrent data flow is unavailable");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const stream = sourceFile.createReadStream({ start: 0, end: Math.min(file.size - 1, 64 * 1024 - 1) });
      const stoppable = stream;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stoppable.destroy?.();
          reject(new Error("Torrent data flow timeout: no payload bytes received"));
        }
      }, timeoutMs);
      stream.on("data", (chunk) => {
        if (!settled && chunk.byteLength > 0) {
          settled = true;
          clearTimeout(timer);
          stoppable.destroy?.();
          resolve(chunk.byteLength);
        }
      });
      stream.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }
  async openStream(infoHash, fileIndex) {
    const hash = infoHash.toLowerCase();
    const manifest = this.manifests.get(hash);
    if (!manifest) throw new Error("Torrent metadata is not loaded");
    const file = manifest.files[fileIndex];
    if (!file) throw new Error("File index is out of range");
    this.cancelIdleCleanup(hash);
    const torrent = this.torrents.get(hash);
    const streamId = randomId("stream");
    const status = {
      streamId,
      infoHash: hash,
      fileIndex,
      phase: "buffering",
      progress: 0,
      downloaded: 0,
      uploaded: 0,
      peers: torrent?.numPeers ?? 0,
      bufferedBytes: 0,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.streams.set(streamId, status);
    let streamSet = this.torrentStreams.get(hash);
    if (!streamSet) {
      streamSet = /* @__PURE__ */ new Set();
      this.torrentStreams.set(hash, streamSet);
    }
    streamSet.add(streamId);
    const selectedPieces = [];
    if (torrent) {
      let refMap = this.pieceRefCounts.get(hash);
      if (!refMap) {
        refMap = /* @__PURE__ */ new Map();
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
            } catch {
            }
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
      status: () => ({ ...this.streams.get(streamId) }),
      destroy: async () => {
        if (isStreamDestroyed) return;
        isStreamDestroyed = true;
        this.cleanupStream(streamId);
      }
    };
  }
  cleanupStream(streamId) {
    this.streams.delete(streamId);
    const handleInfo = this.activeStreamHandles.get(streamId);
    if (!handleInfo) return;
    this.activeStreamHandles.delete(streamId);
    const { infoHash, pieces } = handleInfo;
    const streamSet = this.torrentStreams.get(infoHash);
    if (streamSet) {
      streamSet.delete(streamId);
    }
    const torrent = this.torrents.get(infoHash);
    const refMap = this.pieceRefCounts.get(infoHash);
    if (refMap && torrent) {
      for (const piece of pieces) {
        const count = (refMap.get(piece) ?? 1) - 1;
        if (count <= 0) {
          refMap.delete(piece);
          try {
            torrent.deselect(piece, piece, 0);
          } catch {
          }
        } else {
          refMap.set(piece, count);
        }
      }
    }
    if (!streamSet || streamSet.size === 0) {
      this.scheduleIdleCleanup(infoHash);
    }
    this.emit("stream_destroyed", { streamId, infoHash });
  }
  scheduleIdleCleanup(infoHash) {
    this.cancelIdleCleanup(infoHash);
    if (this.idleTorrentGracePeriodMs <= 0) {
      this.destroyTorrent(infoHash).catch(() => {
      });
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(infoHash);
      const activeCount = this.torrentStreams.get(infoHash)?.size ?? 0;
      if (activeCount === 0) {
        this.destroyTorrent(infoHash).catch(() => {
        });
      }
    }, this.idleTorrentGracePeriodMs);
    this.idleTimers.set(infoHash, timer);
  }
  cancelIdleCleanup(infoHash) {
    const timer = this.idleTimers.get(infoHash);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(infoHash);
    }
  }
  async enforceCapacity() {
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
  enforceCapacitySync() {
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
  createTestReadable(streamId, file, range) {
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
          status.phase = sent === total ? "complete" : "streaming";
          status.downloaded = sent;
          status.progress = total ? sent / total : 1;
          status.bufferedBytes = Math.max(0, total - sent);
          status.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
          this.emit("status", { ...status });
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
  getStatus(streamId) {
    return this.streams.get(streamId) ? { ...this.streams.get(streamId) } : void 0;
  }
  getActiveStreamsCount(infoHash) {
    if (infoHash) {
      return this.torrentStreams.get(infoHash.toLowerCase())?.size ?? 0;
    }
    return this.streams.size;
  }
  getActiveTorrentsCount() {
    return this.manifests.size;
  }
  getAdminSnapshot() {
    const torrents = [...this.manifests.values()].map((manifest) => {
      const torrent = this.torrents.get(manifest.infoHash);
      return {
        infoHash: manifest.infoHash,
        name: manifest.name,
        totalSize: manifest.totalSize,
        progress: torrent?.progress ?? 0,
        peers: torrent?.numPeers ?? 0,
        activeStreams: this.torrentStreams.get(manifest.infoHash)?.size ?? 0,
        files: manifest.files.length
      };
    });
    return { torrents, streams: [...this.streams.values()].map((stream) => ({ ...stream })) };
  }
  async destroy() {
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
      await this.destroyTorrent(hash).catch(() => {
      });
    }
    this.manifests.clear();
    this.torrents.clear();
    this.removeAllListeners();
    if (this.client) {
      await new Promise((resolve) => this.client.destroy(() => resolve()));
    }
  }
};

// src/routes/index.ts
import { randomBytes } from "node:crypto";

// src/controllers/metadata-controller.ts
function metadataController(engine) {
  return async (request, reply) => {
    const body = request.body;
    const torrent = request.file;
    if (!body?.magnet && !torrent?.buffer) return reply.code(400).send({ error: "Provide magnet or torrent upload" });
    try {
      const manifest = await engine.inspect(body?.magnet ? { magnet: body.magnet } : { torrentBuffer: torrent.buffer });
      return reply.send({ data: manifest });
    } catch (error) {
      const message = error.message;
      const status = /timeout|timed out|swarm|peer/i.test(message) ? 504 : 422;
      return reply.code(status).send({ error: message, code: status === 504 ? "SWARM_TIMEOUT" : "INVALID_TORRENT" });
    }
  };
}

// src/controllers/resolver-controller.ts
import { randomUUID } from "node:crypto";
function resolverController(resolver, tracker) {
  return async (request, reply) => {
    if (!resolver) return reply.code(503).send({ error: "Resolver is temporarily unavailable" });
    const query = request.body;
    const requestId = randomUUID();
    const trace = tracker?.start({ requestId, route: (request.url ?? "/").split("?")[0] ?? "/", method: request.method, requestType: query.type ?? "unknown" });
    const receivedAt = trace?.receivedAt ?? (/* @__PURE__ */ new Date()).toISOString();
    reply.header("x-request-id", requestId);
    try {
      const result = await resolver.findStream(query);
      const subtitles = "subtitles" in result ? result.subtitles : [];
      const quality = "quality" in result ? result.quality : void 0;
      const diagnostics = { requestId, receivedAt, completedAt: (/* @__PURE__ */ new Date()).toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status: "completed", phase: "completed", attempted: "attempted" in result ? result.attempted : void 0, source: "candidate" in result ? result.candidate.source : "hls", cacheHit: "cacheHit" in result ? result.cacheHit : false, subtitleStatus: subtitles.length ? "found" : "not_found", subtitleLanguages: subtitles.map((item) => item.lang), qualityStatus: quality?.resolution && quality.resolution !== "unknown" ? "found" : "unknown", quality: quality?.resolution };
      const { requestId: _completedRequestId, ...completedTrace } = diagnostics;
      tracker?.finish(requestId, completedTrace);
      return reply.send({ requestId, diagnostics, data: result });
    } catch (error) {
      const message = error.message;
      const status = /required|invalid query|malformed/i.test(message) ? 400 : /timeout|timed out|no active peers|swarm/i.test(message) ? 504 : 404;
      const code = status === 400 ? "INVALID_QUERY" : status === 504 ? "SWARM_TIMEOUT" : "NO_HEALTHY_TORRENT";
      const state = status === 504 ? "timeout" : "failed";
      const diagnostics = { requestId, receivedAt, completedAt: (/* @__PURE__ */ new Date()).toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status: state, phase: state, httpStatus: status, errorCode: code, errorMessage: message };
      const { requestId: _failedRequestId, ...failedTrace } = diagnostics;
      tracker?.finish(requestId, failedTrace);
      return reply.code(status).send({ requestId, diagnostics, error: message, code });
    }
  };
}

// src/controllers/stream-controller.ts
function parseRange(value, size) {
  if (!value) return void 0;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) throw new Error("Invalid Range header");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
  const end = match[2] ? Number(match[2]) : size - 1;
  if (start < 0 || end < start || start >= size) throw new Error("Range not satisfiable");
  return { start, end: Math.min(end, size - 1) };
}
function streamController(engine) {
  return async (request, reply) => {
    const params = request.params;
    let handle;
    let stream;
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (stream && typeof stream.destroy === "function") {
        try {
          stream.destroy();
        } catch {
        }
      }
      if (handle) {
        try {
          await handle.destroy();
        } catch {
        }
      }
    };
    try {
      const fileIndex = Number(params.fileIndex);
      if (Number.isNaN(fileIndex)) {
        return reply.code(400).send({ error: "Invalid file index" });
      }
      handle = await engine.openStream(params.infoHash, fileIndex);
      const range = parseRange(request.headers.range, handle.size);
      const start = range?.start ?? 0;
      const end = range?.end ?? handle.size - 1;
      reply.header("Accept-Ranges", "bytes").header("Content-Type", handle.file.mimeType).header("Content-Length", end - start + 1).header("Cache-Control", "no-store");
      if (range) {
        reply.header("Content-Range", `bytes ${start}-${end}/${handle.size}`);
        reply.code(206);
      } else {
        reply.code(200);
      }
      stream = handle.createReadStream(range);
      request.raw.on("close", cleanup);
      request.raw.on("error", cleanup);
      stream.on("end", cleanup);
      stream.on("close", cleanup);
      stream.on("error", cleanup);
      return reply.send(stream);
    } catch (error) {
      await cleanup();
      const message = error.message;
      if (message.includes("Range") || message.includes("range")) {
        const manifest = engine.getManifest(params.infoHash);
        const file = manifest?.files[Number(params.fileIndex)];
        if (file) {
          reply.header("Content-Range", `bytes */${file.size}`);
        }
        return reply.code(416).send({ error: message });
      }
      return reply.code(404).send({ error: message });
    }
  };
}
function statusController(engine) {
  return async (request, reply) => {
    const id = request.params.streamId;
    const status = engine.getStatus(id);
    return status ? reply.send({ data: status }) : reply.code(404).send({ error: "Stream not found" });
  };
}

// src/controllers/subtitle-controller.ts
async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function toVtt(input, name) {
  if (/\.vtt$/i.test(name)) return input.startsWith("WEBVTT") ? input : `WEBVTT

${input}`;
  if (/\.srt$/i.test(name)) return `WEBVTT

${input.replace(/\r?\n/g, "\n").replace(/(\d{2}:\d{2}):(\d{2},\d{3})/g, "$1:$2").replace(/\n(\d{2}:\d{2}:\d{2}),(\d{3})/g, "\n$1.$2")}`;
  return `WEBVTT

${input.replace(/\{[^}]+\}/g, "")}`;
}
function subtitleController(engine) {
  return async (request, reply) => {
    const params = request.params;
    try {
      const handle = await engine.openStream(params.infoHash, Number(params.fileIndex));
      const body = toVtt((await readAll(handle.createReadStream())).toString("utf8"), handle.file.name);
      return reply.header("Access-Control-Allow-Origin", "*").header("Cache-Control", "public, max-age=300").type("text/vtt; charset=utf-8").send(body);
    } catch (error) {
      return reply.code(404).send({ error: error.message });
    }
  };
}

// src/admin-dashboard.ts
function adminDashboardHtml(nonce) {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TorFlow Control Center</title>
<style>
:root{color-scheme:dark;--bg:#07111f;--panel:#0e1b2d;--panel2:#13243a;--line:#203651;--text:#e8f1ff;--muted:#8fa6c4;--cyan:#5eead4;--blue:#60a5fa;--red:#fb7185;--amber:#fbbf24;--green:#34d399}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#163252 0,transparent 34%),var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:28px}.eyebrow{color:var(--cyan);font-size:12px;letter-spacing:.16em;text-transform:uppercase}.title{font-size:30px;font-weight:800;margin:4px 0}.muted{color:var(--muted)}.auth{display:flex;gap:8px;min-width:min(460px,100%)}input{background:#091727;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:11px 13px;outline:none;flex:1}button{border:0;border-radius:10px;padding:11px 15px;background:linear-gradient(135deg,#2dd4bf,#3b82f6);color:#03121e;font-weight:800;cursor:pointer}button.secondary{background:var(--panel2);color:var(--text);border:1px solid var(--line)}.status{min-height:22px;color:var(--muted);margin:8px 0 18px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card,.section{background:linear-gradient(145deg,rgba(19,36,58,.94),rgba(10,25,42,.94));border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 35px #0003}.card{padding:18px}.label{color:var(--muted);font-size:12px}.value{font-size:27px;font-weight:800;margin-top:6px}.accent{color:var(--cyan)}.section{margin-top:18px;padding:18px;overflow:hidden}.section h2{font-size:16px;margin:0 0 14px}.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:720px}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #1c3049;white-space:nowrap}th{color:var(--muted);font-size:12px;font-weight:600}td{font-size:13px}.pill{display:inline-flex;border-radius:999px;padding:3px 9px;background:#123a3b;color:var(--green);font-size:12px}.pill.warn{background:#433518;color:var(--amber)}.pill.err{background:#431d2b;color:var(--red)}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}.empty{color:var(--muted);padding:18px 0}.footer{color:var(--muted);font-size:12px;margin-top:20px}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.top{flex-direction:column}.auth{width:100%}}@media(max-width:600px){main{padding:16px}.grid{grid-template-columns:1fr}.auth{flex-direction:column}.title{font-size:24px}}
</style>
</head>
<body><main>
<header class="top"><div><div class="eyebrow">TorFlow / Operations</div><div class="title">Control Center</div><div class="muted">Live service health, streaming capacity and runtime telemetry</div></div><div class="auth"><input id="key" type="password" placeholder="x-api-key" autocomplete="off" /><button onclick="connect()">Connect</button></div></header>
<div id="status" class="status">Enter the configured API key to load protected telemetry.</div>
<section class="grid" id="cards"><div class="card"><div class="label">Service</div><div class="value">\u2014</div></div><div class="card"><div class="label">Uptime</div><div class="value">\u2014</div></div><div class="card"><div class="label">Active torrents</div><div class="value">\u2014</div></div><div class="card"><div class="label">Active streams</div><div class="value">\u2014</div></div><div class="card"><div class="label">Memory RSS</div><div class="value">\u2014</div></div><div class="card"><div class="label">Requests</div><div class="value">\u2014</div></div><div class="card"><div class="label">Error rate</div><div class="value">\u2014</div></div><div class="card"><div class="label">Version</div><div class="value">\u2014</div></div></section>
<section class="section"><div class="section-head"><h2>Active torrents</h2><button class="secondary" onclick="loadAll()">Refresh</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Info hash</th><th>Peers</th><th>Progress</th><th>Streams</th><th>Size</th></tr></thead><tbody id="torrents"><tr><td colspan="6" class="empty">Connect to load data.</td></tr></tbody></table></div></section>
<section class="section"><h2>Active streams</h2><div class="table-wrap"><table><thead><tr><th>Stream ID</th><th>Info hash</th><th>File</th><th>Phase</th><th>Peers</th><th>Progress</th><th>Updated</th></tr></thead><tbody id="streams"><tr><td colspan="7" class="empty">Connect to load data.</td></tr></tbody></table></div></section>
<section class="section"><div class="section-head"><h2>Countries \u2014 observed requests</h2><span class="muted" id="countryScope">No data</span></div><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Country code</th><th>Requests</th><th>Share</th></tr></thead><tbody id="countries"><tr><td colspan="4" class="empty">Connect to load data.</td></tr></tbody></table></div></section>
<section class="section"><h2>Runtime requests</h2><div class="table-wrap"><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody id="runtime"><tr><td colspan="2" class="empty">Connect to load data.</td></tr></tbody></table></div></section>
<section class="section"><h2>Recent resolver requests</h2><div class="table-wrap"><table><thead><tr><th>Request ID</th><th>Type</th><th>Status</th><th>Duration</th><th>Source</th><th>Subtitles</th><th>Quality</th><th>Received</th></tr></thead><tbody id="requests"><tr><td colspan="8" class="empty">Connect to load data.</td></tr></tbody></table></div></section>
<div class="footer">Data refreshes every 5 seconds. Secrets are never rendered by the dashboard.</div>
</main><script nonce="${nonce}">
const keyInput=document.getElementById('key'); const statusEl=document.getElementById('status'); let key=sessionStorage.getItem('torflow_admin_key')||''; keyInput.value=key;
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtBytes=n=>{n=Number(n||0);if(n<1024)return n+' B';let u=['KB','MB','GB','TB'],i=-1;do{n/=1024;i++}while(n>=1024&&i<u.length-1);return n.toFixed(1)+' '+u[i]};
const fmtUptime=s=>{s=Number(s||0);return Math.floor(s/86400)+'d '+Math.floor(s%86400/3600)+'h '+Math.floor(s%3600/60)+'m'};
async function api(path){const r=await fetch(path,{headers:{'x-api-key':key}});if(r.status===401)throw Error('Unauthorized API key');if(!r.ok)throw Error('Request failed: '+r.status);return r.json()}
function connect(){key=keyInput.value.trim();if(!key){statusEl.textContent='API key is required.';return}sessionStorage.setItem('torflow_admin_key',key);loadAll()}
function renderCards(o){const vals=[o.service?.status||'online',fmtUptime(o.runtime?.uptimeSeconds),o.engine?.activeTorrents??0,o.engine?.activeStreams??0,fmtBytes(o.runtime?.memory?.rss),o.requests?.total??0,((o.requests?.errorRate||0)*100).toFixed(2)+'%',o.runtime?.version||'unknown'];document.querySelectorAll('#cards .value').forEach((e,i)=>e.textContent=vals[i])}
async function loadAll(){if(!key){return}try{const [o,t,s]=await Promise.all([api('/admin/api/overview'),api('/admin/api/torrents'),api('/admin/api/streams'),api('/admin/api/requests?limit=50')]);renderCards(o);document.getElementById('torrents').innerHTML=t.data.length?t.data.map(x=>\`<tr><td>\${esc(x.name)}</td><td class="mono">\${esc(x.infoHash)}</td><td>\${x.peers}</td><td>\${(x.progress*100).toFixed(1)}%</td><td>\${x.activeStreams}</td><td>\${fmtBytes(x.totalSize)}</td></tr>\`).join(''):'<tr><td colspan="6" class="empty">No active torrents.</td></tr>';document.getElementById('streams').innerHTML=s.data.length?s.data.map(x=>\`<tr><td class="mono">\${esc(x.streamId)}</td><td class="mono">\${esc(x.infoHash)}</td><td>\${esc(x.fileName)}</td><td><span class="pill">\${esc(x.phase)}</span></td><td>\${x.peers}</td><td>\${(x.progress*100).toFixed(1)}%</td><td>\${esc(x.updatedAt)}</td></tr>\`).join(''):'<tr><td colspan="7" class="empty">No active streams.</td></tr>';document.getElementById('runtime').innerHTML=Object.entries(o.requests||{}).map(([k,v])=>\`<tr><td>\${esc(k)}</td><td>\${esc(v)}</td></tr>\`).join('');document.getElementById('requests').innerHTML=r.data.length?r.data.map(x=>\`<tr><td class="mono">\${esc(x.requestId.slice(0,12))}\u2026</td><td>\${esc(x.requestType||'unknown')}</td><td><span class="pill">\${esc(x.status)}</span></td><td>\${x.durationMs??'\u2014'} ms</td><td>\${esc(x.source||'\u2014')}</td><td>\${esc(x.subtitleStatus||'\u2014')}</td><td>\${esc(x.quality||'\u2014')}</td><td>\${esc(x.receivedAt)}</td></tr>\`).join(''):'<tr><td colspan="8" class="empty">No resolver requests yet.</td></tr>';document.getElementById('countryScope').textContent=o.countries?.scope||'Observed requests';document.getElementById('countries').innerHTML=o.countries?.data?.length?o.countries.data.map((x,i)=>\`<tr><td>\${i+1}</td><td class="mono">\${esc(x.country)}</td><td>\${x.requests}</td><td>\${x.percentage.toFixed(2)}%</td></tr>\`).join(''):'<tr><td colspan="4" class="empty">No country observations yet.</td></tr>';statusEl.textContent='Connected \xB7 last update '+new Date().toLocaleTimeString();statusEl.style.color='var(--green)'}catch(e){statusEl.textContent=e.message;statusEl.style.color='var(--red)'}}
loadAll();setInterval(loadAll,5000);
</script></body></html>`;
}

// src/observability/request-tracker.ts
var RequestTracker = class {
  constructor(maxRecords = 500) {
    this.maxRecords = maxRecords;
  }
  maxRecords;
  records = [];
  start(input) {
    const record = { ...input, receivedAt: (/* @__PURE__ */ new Date()).toISOString(), status: "received", phase: "received" };
    this.records.unshift(record);
    this.trim();
    return record;
  }
  finish(requestId, patch) {
    const record = this.records.find((item) => item.requestId === requestId);
    if (!record) return void 0;
    Object.assign(record, patch, { requestId, completedAt: (/* @__PURE__ */ new Date()).toISOString(), durationMs: Date.now() - Date.parse(record.receivedAt) });
    return record;
  }
  recent(limit = 100) {
    return this.records.slice(0, Math.min(Math.max(limit, 1), 500)).map((record) => ({ ...record, subtitleLanguages: record.subtitleLanguages ? [...record.subtitleLanguages] : void 0 }));
  }
  trim() {
    if (this.records.length > this.maxRecords) this.records.length = this.maxRecords;
  }
};

// src/routes/index.ts
async function registerRoutes(app, engine, resolver, options) {
  const runtime = options ?? { metrics: { startedAt: Date.now(), total: 0, errors: 0, byStatus: {}, lastLatencyMs: 0, countries: /* @__PURE__ */ new Map() }, requestTracker: new RequestTracker(), config: { nodeEnv: "development", maxConcurrentTorrents: 4, resolverTimeoutMs: 15e3, cacheMaxBytes: 0, cacheTtlSeconds: 0 } };
  const adminGuard = async (request, reply) => {
    if (!runtime.adminKey) {
      reply.code(503).send({ error: "Admin authentication is not configured" });
      return false;
    }
    if (request.headers["x-api-key"] !== runtime.adminKey) {
      reply.code(401).send({ error: "Unauthorized" });
      return false;
    }
    return true;
  };
  app.get("/health", async (_request, reply) => reply.header("Cache-Control", "no-store").send({ status: "ok", service: "torflow" }));
  app.get("/ready", async (_request, reply) => reply.header("Cache-Control", "no-store").send({ status: "ready", service: "torflow" }));
  app.get("/admin", async (_request, reply) => {
    const nonce = randomBytes(18).toString("base64");
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store").header("Content-Security-Policy", `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`).send(adminDashboardHtml(nonce));
  });
  app.get("/admin/api/overview", async (request, reply) => {
    if (!await adminGuard(request, reply)) return;
    const snapshot = engine.getAdminSnapshot();
    const memory = process.memoryUsage();
    const total = runtime.metrics.total;
    const countryTotal = [...runtime.metrics.countries.values()].reduce((sum, count) => sum + count, 0);
    const countries = [...runtime.metrics.countries.entries()].map(([country, count]) => ({ country, requests: count, percentage: countryTotal ? Number((count / countryTotal * 100).toFixed(2)) : 0 })).sort((a, b) => b.requests - a.requests);
    return reply.header("Cache-Control", "no-store").send({
      service: { status: "ok", environment: runtime.config.nodeEnv },
      runtime: { uptimeSeconds: process.uptime(), version: process.env.npm_package_version ?? "unknown", node: process.version, memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external } },
      engine: { activeTorrents: snapshot.torrents.length, activeStreams: snapshot.streams.length, maxConcurrentTorrents: runtime.config.maxConcurrentTorrents },
      requests: { total, errors: runtime.metrics.errors, errorRate: total ? runtime.metrics.errors / total : 0, lastLatencyMs: runtime.metrics.lastLatencyMs, byStatus: runtime.metrics.byStatus },
      countries: { scope: "observed requests on this running instance", uniqueUsers: false, totalObserved: countryTotal, data: countries },
      config: { resolverTimeoutMs: runtime.config.resolverTimeoutMs, cacheMaxBytes: runtime.config.cacheMaxBytes, cacheTtlSeconds: runtime.config.cacheTtlSeconds }
    });
  });
  app.get("/admin/api/torrents", async (request, reply) => {
    if (!await adminGuard(request, reply)) return;
    return reply.header("Cache-Control", "no-store").send({ data: engine.getAdminSnapshot().torrents });
  });
  app.get("/admin/api/streams", async (request, reply) => {
    if (!await adminGuard(request, reply)) return;
    const snapshot = engine.getAdminSnapshot();
    const data = snapshot.streams.map((stream) => ({ ...stream, fileName: engine.getManifest(stream.infoHash)?.files[stream.fileIndex]?.name ?? `file-${stream.fileIndex}` }));
    return reply.header("Cache-Control", "no-store").send({ data });
  });
  app.get("/admin/api/requests", async (request, reply) => {
    if (!await adminGuard(request, reply)) return;
    const rawLimit = Number(request.query.limit ?? 100);
    return reply.header("Cache-Control", "no-store").send({ data: runtime.requestTracker.recent(Number.isFinite(rawLimit) ? rawLimit : 100) });
  });
  app.post("/v1/metadata/inspect", { schema: { body: { type: "object", required: ["magnet"], additionalProperties: false, properties: { magnet: { type: "string", minLength: 20, maxLength: 4096 } } } } }, metadataController(engine));
  app.post("/v1/resolver/find-stream", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        anyOf: [{ required: ["title"] }, { required: ["query"] }, { required: ["artist"] }, { required: ["album"] }, { required: ["track"] }, { required: ["imdb_id"] }, { required: ["tmdb_id"] }],
        properties: {
          type: { type: "string", enum: ["movie", "series", "music", "tv_program"] },
          title: { type: "string", minLength: 1, maxLength: 300 },
          query: { type: "string", minLength: 1, maxLength: 500 },
          artist: { type: "string", minLength: 1, maxLength: 200 },
          album: { type: "string", minLength: 1, maxLength: 200 },
          track: { type: "string", minLength: 1, maxLength: 200 },
          year: { type: "integer", minimum: 1800, maximum: 2200 },
          season: { type: "integer", minimum: 0, maximum: 1e3 },
          episode: { type: "integer", minimum: 0, maximum: 1e4 },
          date: { type: "string", maxLength: 40 },
          network: { type: "string", maxLength: 120 },
          country: { type: "string", maxLength: 80 },
          part: { type: "integer", minimum: 0, maximum: 1e4 },
          imdb_id: { type: "string", pattern: "^tt[0-9]{3,12}$" },
          tmdb_id: { type: "string", pattern: "^[0-9]{1,12}$" },
          preferredQuality: { type: "string", enum: ["2160p", "1080p", "720p", "480p"] },
          preferredSubtitleLanguages: { type: "array", maxItems: 20, items: { type: "string", minLength: 2, maxLength: 12 } },
          preferredSource: { type: "string", enum: ["torrent", "hls", "auto"] },
          hlsUrl: { type: "string", format: "uri", maxLength: 2048 }
        }
      }
    }
  }, resolverController(resolver, runtime.requestTracker));
  const torrentParams = { type: "object", required: ["infoHash"], additionalProperties: false, properties: { infoHash: { type: "string", pattern: "^(?:[a-fA-F0-9]{40}|[A-Z2-7a-z2-7]{32})$" } } };
  const streamParams = { type: "object", required: ["infoHash", "fileIndex"], additionalProperties: false, properties: { ...torrentParams.properties, fileIndex: { type: "string", pattern: "^(?:0|[1-9][0-9]{0,5})$" } } };
  const streamIdParams = { type: "object", required: ["streamId"], additionalProperties: false, properties: { streamId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" } } };
  app.get("/v1/torrents/:infoHash", { schema: { params: torrentParams } }, async (request, reply) => {
    const data = engine.getManifest(request.params.infoHash);
    return data ? reply.send({ data }) : reply.code(404).send({ error: "Metadata not found" });
  });
  app.get("/v1/torrents/:infoHash/files/:fileIndex/stream", { schema: { params: streamParams } }, streamController(engine));
  app.get("/v1/subtitles/:infoHash/:fileIndex", { schema: { params: streamParams } }, subtitleController(engine));
  app.get("/v1/streams/:streamId/status", { schema: { params: streamIdParams } }, statusController(engine));
  app.get("/v1/streams/:streamId/events", { schema: { params: streamIdParams } }, async (request, reply) => {
    const id = request.params.streamId;
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const listener = (event) => {
      if (event.streamId === id) {
        reply.raw.write(`data: ${JSON.stringify(event)}

`);
      }
    };
    engine.on("status", listener);
    request.raw.on("close", () => {
      engine.off("status", listener);
    });
  });
}

// src/resolver/ranking.ts
var resolutionScore = { "2160p": 40, "1080p": 35, "720p": 25, "480p": 10, unknown: 0 };
var codecScore = { h264: 30, hevc: 20, vp9: 10, av1: 5, unknown: 0 };
var audioScore = { aac: 15, mp3: 10, ac3: 8, eac3: 6, opus: 4, unknown: 0 };
function parseQuality(title) {
  const normalized = title.toLowerCase();
  const resolution = normalized.includes("2160p") || normalized.includes("4k") ? "2160p" : normalized.includes("1080p") ? "1080p" : normalized.includes("720p") ? "720p" : normalized.includes("480p") ? "480p" : "unknown";
  const videoCodec = normalized.includes("h264") || normalized.includes("h.264") || normalized.includes("x264") ? "h264" : normalized.includes("hevc") || normalized.includes("h265") || normalized.includes("x265") ? "hevc" : normalized.includes("av1") ? "av1" : normalized.includes("vp9") ? "vp9" : "unknown";
  const audioCodec = normalized.includes("eac3") || normalized.includes("ddp") ? "eac3" : normalized.includes("ac3") || normalized.includes("dd5") ? "ac3" : normalized.includes("aac") ? "aac" : normalized.includes("mp3") ? "mp3" : normalized.includes("opus") ? "opus" : "unknown";
  return { resolution, videoCodec, audioCodec, score: resolutionScore[resolution] + codecScore[videoCodec] + audioScore[audioCodec] };
}
function parseAudioQuality(title) {
  const normalized = title.toLowerCase();
  const audioFormat = normalized.includes("flac") ? "flac" : normalized.includes("alac") ? "alac" : normalized.includes("320") || normalized.includes("320kbps") ? "mp3-320" : normalized.includes("aac") || normalized.includes("m4a") ? "aac" : normalized.includes("opus") || normalized.includes("ogg") ? "opus" : normalized.includes("wav") ? "wav" : normalized.includes("mp3") ? "mp3-320" : "unknown";
  const bitrateMatch = normalized.match(/(\d{2,4})\s*kbps/);
  const bitrateKbps = bitrateMatch ? Number(bitrateMatch[1]) : audioFormat === "mp3-320" ? 320 : void 0;
  const formatScore = { flac: 60, alac: 55, "mp3-320": 48, aac: 36, opus: 34, wav: 52, unknown: 0 };
  return { resolution: "unknown", videoCodec: "unknown", audioCodec: audioFormat === "mp3-320" ? "mp3" : audioFormat === "opus" ? "opus" : audioFormat === "aac" ? "aac" : "unknown", audioFormat, bitrateKbps, score: formatScore[audioFormat] + Math.min(25, Math.round((bitrateKbps ?? 0) / 32)) };
}
function cleanQueryTerm(term) {
  return term.replace(/[\(\)\[\]\{\}\:\_\-\.\,\?\!]/g, " ").replace(/\s+/g, " ").trim();
}
function queryText(query) {
  const rawTitle = query.title ?? query.query ?? "";
  const cleanedTitle = cleanQueryTerm(rawTitle);
  const parts = [cleanedTitle || rawTitle, query.artist, query.album, query.track, query.year, query.season !== void 0 ? `S${String(query.season).padStart(2, "0")}` : void 0, query.episode !== void 0 ? `E${String(query.episode).padStart(2, "0")}` : void 0];
  return parts.filter(Boolean).join(" ");
}
function rankCandidates(candidates, query) {
  const minimumSeeders = query?.type === "music" ? 2 : 1;
  const seen = /* @__PURE__ */ new Set();
  return candidates.filter((candidate) => {
    const key = candidate.magnet.toLowerCase();
    if (!candidate.magnet.startsWith("magnet:?") || Number(candidate.seeders) < minimumSeeders || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((candidate) => {
    const quality = query?.type === "music" ? parseAudioQuality(candidate.title) : parseQuality(candidate.title);
    const seedScore = Math.min(100, Math.log10(candidate.seeders + 1) * 45);
    const preferenceScore = query?.preferredQuality && quality.resolution === query.preferredQuality ? 30 : 0;
    return { ...candidate, seeders: Number(candidate.seeders), quality, score: Number((seedScore + quality.score + preferenceScore).toFixed(3)) };
  }).sort((a, b) => b.score - a.score || b.seeders - a.seeders);
}

// src/resolver/tv-program.ts
var TV_PATTERNS = [
  /\bthe voice\b/i,
  /\bthe voice kids\b/i,
  /\bgot talent\b/i,
  /\bmasterchef\b/i,
  /\bsurvivor\b/i,
  /\bbig brother\b/i,
  /\bamerican idol\b/i,
  /\bx factor\b/i,
  /\btop gear\b/i,
  /\bgrand tour\b/i,
  /\bshark tank\b/i,
  /\bdrag race\b/i,
  /\bdancing with the stars\b/i,
  /\bstrictly come dancing\b/i,
  /\bthe tonight show\b/i,
  /\blate night\b/i,
  /\bdaily show\b/i,
  /\blast week tonight\b/i,
  /\bhell['\\s]?s kitchen\b/i,
  /\bbake off\b/i,
  /\bgreat british baking\b/i,
  /\blove island\b/i,
  /\bthe bachelor\b/i,
  /\bthe bachelorette\b/i,
  /\bmasked singer\b/i,
  /\bبرنامج\b/i,
  /\bذا فويس\b/i,
  /\bاراب كاستينج\b/i,
  /\bاراب غوت تالنت\b/i,
  /\bسيرفايفر\b/i
];
var CHANNEL_PREFIXES = /^(?:\[?(?:bbc|nbc|mbc|itv|cbs|abc|fox|hbo|netflix|discovery|tlc|hgtv|mtv|e!|channel\s*4|channel\s*5)\]?[\s._\-]+)/i;
function isTvProgram(query) {
  if (query.type === "tv_program") return true;
  const raw = `${query.title ?? ""} ${query.query ?? ""}`;
  return TV_PATTERNS.some((pat) => pat.test(raw));
}
function cleanTvChannelPrefixes(text) {
  return text.replace(CHANNEL_PREFIXES, "").trim();
}
function tvProgramQueryVariants(query) {
  const base = cleanQueryTerm(query.title ?? query.query ?? "") || (query.title ?? query.query ?? "");
  const variants = [];
  const networkStr = query.network ? ` ${cleanQueryTerm(query.network)}` : "";
  const countryStr = query.country ? ` ${cleanQueryTerm(query.country)}` : "";
  const showBases = [base];
  if (countryStr) showBases.push(`${base}${countryStr}`);
  if (networkStr) showBases.push(`${base}${networkStr}`);
  for (const b of showBases) {
    if (query.season !== void 0 && query.episode !== void 0) {
      const s = query.season;
      const e = query.episode;
      const sPadded = String(s).padStart(2, "0");
      const ePadded = String(e).padStart(2, "0");
      variants.push(`${b} S${sPadded}E${ePadded}`);
      variants.push(`${b} S${s} E${e}`);
      variants.push(`${b} Season ${s} Episode ${e}`);
      variants.push(`${b} ${s}x${ePadded}`);
      variants.push(`${b} Episode ${e}`);
      variants.push(`${b} S${sPadded}`);
    } else if (query.episode !== void 0) {
      variants.push(`${b} Episode ${query.episode}`);
      variants.push(`${b} E${String(query.episode).padStart(2, "0")}`);
      variants.push(`${b} Part ${query.episode}`);
    } else if (query.part !== void 0) {
      variants.push(`${b} Part ${query.part}`);
      variants.push(`${b} Episode ${query.part}`);
    }
    if (query.date) {
      const cleanDate = query.date.replace(/[^0-9]/g, " ").replace(/\s+/g, " ").trim();
      variants.push(`${b} ${cleanDate}`);
      variants.push(`${b} ${query.date.replace(/\-/g, ".")}`);
    }
    if (query.year) {
      variants.push(`${b} ${query.year}`);
    }
    variants.push(b);
  }
  return [...new Set(variants.filter(Boolean))];
}

// src/resolver/file-selector.ts
var LANGS = {
  ara: { code: "ara", label: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629" },
  ar: { code: "ara", label: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629" },
  arabic: { code: "ara", label: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629" },
  eng: { code: "eng", label: "English" },
  en: { code: "eng", label: "English" },
  english: { code: "eng", label: "English" },
  fre: { code: "fra", label: "Fran\xE7ais" },
  fra: { code: "fra", label: "Fran\xE7ais" },
  fr: { code: "fra", label: "Fran\xE7ais" },
  spa: { code: "spa", label: "Espa\xF1ol" },
  es: { code: "spa", label: "Espa\xF1ol" },
  ger: { code: "deu", label: "Deutsch" },
  deu: { code: "deu", label: "Deutsch" },
  de: { code: "deu", label: "Deutsch" }
};
var SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
var AUDIO_EXT = /\.(mp3|flac|m4a|aac|wav|ogg|opus|alac)$/i;
var VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|ts|flv)$/i;
var AUDIO_FORMAT_RANK = {
  ".flac": 100,
  ".alac": 90,
  ".wav": 80,
  ".mp3": 70,
  ".aac": 60,
  ".m4a": 55,
  ".opus": 50,
  ".ogg": 40
};
function subtitleLanguage(name) {
  const tokens = name.toLowerCase().replace(/[._()[\]-]+/g, " ").split(/\s+/);
  return tokens.map((token) => LANGS[token]).find(Boolean) ?? void 0;
}
function selectSubtitleFiles(files) {
  return files.filter((file) => SUB_EXT.test(file.name)).map((file) => {
    const lang = subtitleLanguage(file.name) ?? { code: "und", label: "Unknown" };
    return { file, lang: lang.code, label: lang.label };
  }).sort((a, b) => Number(b.lang === "ara") - Number(a.lang === "ara"));
}
function isSubtitleFile(file) {
  return SUB_EXT.test(file.name);
}
function getAudioRank(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return AUDIO_FORMAT_RANK[ext] ?? 10;
}
function selectMediaFile(files, query) {
  if (!files || !files.length) return void 0;
  if (query.type === "music") {
    const audioFiles = files.filter((f) => AUDIO_EXT.test(f.name) || f.mimeType?.startsWith("audio/"));
    const candidateFiles = audioFiles.length ? audioFiles : files;
    if (query.track) {
      const trackTarget = query.track.toLowerCase().trim();
      const trackNum = parseInt(trackTarget, 10);
      const isNumeric = !Number.isNaN(trackNum) && String(trackNum) === trackTarget;
      const matched = candidateFiles.filter((f) => {
        const nameLower = f.name.toLowerCase();
        if (isNumeric) {
          const numRegex = new RegExp(`(?:^|[^0-9])0*${trackNum}(?:[^0-9]|$)`);
          return numRegex.test(nameLower);
        }
        return nameLower.includes(trackTarget);
      });
      if (matched.length > 0) {
        return matched.sort((a, b) => {
          let scoreA = getAudioRank(a.name);
          let scoreB = getAudioRank(b.name);
          if (query.artist && a.name.toLowerCase().includes(query.artist.toLowerCase())) scoreA += 50;
          if (query.artist && b.name.toLowerCase().includes(query.artist.toLowerCase())) scoreB += 50;
          if (query.album && a.name.toLowerCase().includes(query.album.toLowerCase())) scoreA += 30;
          if (query.album && b.name.toLowerCase().includes(query.album.toLowerCase())) scoreB += 30;
          return scoreB - scoreA || b.size - a.size;
        })[0];
      }
      if (candidateFiles.length > 1) {
        return void 0;
      }
    }
    return [...candidateFiles].sort((a, b) => getAudioRank(b.name) - getAudioRank(a.name) || b.size - a.size)[0];
  }
  const videoFiles = files.filter((f) => VIDEO_EXT.test(f.name) || f.mimeType?.startsWith("video/"));
  const candidatePool = videoFiles.length > 0 ? videoFiles : files.filter((f) => !isSubtitleFile(f));
  if (!candidatePool.length) return void 0;
  const nonSamples = candidatePool.filter((f) => !/(?:^|[._\-\s])sample(?:[._\-\s]|$)/i.test(f.name));
  const activeVideos = nonSamples.length > 0 ? nonSamples : candidatePool;
  if ((query.type === "tv_program" || isTvProgram(query)) && query.date) {
    const parts = query.date.split(/[-./ ]/).filter(Boolean);
    const dateMatch = activeVideos.find((f) => parts.every((p) => f.name.includes(p)));
    if (dateMatch) return dateMatch;
  }
  if (query.season !== void 0 && (query.episode !== void 0 || query.part !== void 0)) {
    const s = query.season;
    const ep = query.episode ?? query.part;
    const seasonEpPatterns = [
      new RegExp(`s0*${s}[._\\-\\s]*e0*${ep}(?![0-9])`, "i"),
      new RegExp(`(?<![0-9])0*${s}x0*${ep}(?![0-9])`, "i"),
      new RegExp(`season[._\\-\\s]*0*${s}[._\\-\\s]+episode[._\\-\\s]*0*${ep}(?![0-9])`, "i")
    ];
    const matched = activeVideos.find((f) => {
      const full = `${f.path ? f.path + " " : ""}${f.name}`;
      if (seasonEpPatterns.some((pat) => pat.test(full))) return true;
      const seasonFolder = new RegExp(`(?:^|[\\\\/])(?:season[._\\-\\s]*0*${s}|s0*${s})(?:[\\\\/]|$)`, "i");
      if (f.path && seasonFolder.test(f.path)) {
        const epInFile = new RegExp(`(?:e|ep|episode)[._\\-\\s]*0*${ep}(?![0-9])`, "i");
        const standaloneEp = new RegExp(`(?<![0-9])0*${ep}(?![0-9])`, "i");
        if (epInFile.test(f.name) || standaloneEp.test(f.name)) return true;
      }
      return false;
    });
    if (matched) return matched;
    return void 0;
  }
  if (query.episode !== void 0 || query.part !== void 0) {
    const ep = query.episode ?? query.part;
    const epPatterns = [
      new RegExp(`(?:e|ep|episode|part)[._\\-\\s]*0*${ep}(?![0-9])`, "i"),
      new RegExp(`(?<![0-9])(?:[\\s._\\-]|\\[|\\()0*${ep}(?:[\\s._\\-]|\\]|\\))(?![0-9])`, "i"),
      new RegExp(`(?<![0-9])0*${ep}(?![0-9])`, "i")
    ];
    for (const pat of epPatterns) {
      const match = activeVideos.find((f) => pat.test(f.name) || f.path && pat.test(f.path));
      if (match) return match;
    }
    return void 0;
  }
  return [...activeVideos].sort((a, b) => b.size - a.size)[0];
}

// src/utils/http.ts
async function readTextLimited(response, maxBytes = 2 * 1024 * 1024) {
  if (!response.body) {
    const text2 = await response.text();
    if (Buffer.byteLength(text2) > maxBytes) throw new Error("Upstream response exceeded the configured size limit");
    return text2;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Upstream response exceeded the configured size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

// src/resolver/subtitles.ts
var LANGUAGE_MAP = { ar: "ara", en: "eng", fr: "fra", es: "spa", de: "deu", it: "ita", tr: "tur", pt: "por", ru: "rus", nl: "nld", pl: "pol", ko: "kor", ja: "jpn", ara: "ara", eng: "eng", fra: "fra", spa: "spa", deu: "deu", ita: "ita", tur: "tur", por: "por", rus: "rus", nld: "nld", pol: "pol", kor: "kor", jpn: "jpn" };
var LANGUAGE_LABELS = { ara: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629", eng: "English", fra: "Fran\xE7ais", spa: "Espa\xF1ol", deu: "Deutsch", ita: "Italiano", tur: "T\xFCrk\xE7e", por: "Portugu\xEAs", rus: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439", nld: "Nederlands", pol: "Polski", kor: "\uD55C\uAD6D\uC5B4", jpn: "\u65E5\u672C\u8A9E" };
var ConfiguredSubtitleProvider = class {
  constructor(endpoint = process.env.SUBTITLE_FALLBACK_URL, apiKey = process.env.SUBTITLE_FALLBACK_API_KEY, timeoutMs = 4e3) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }
  endpoint;
  apiKey;
  timeoutMs;
  async search(query, existing, requestedLanguage) {
    if (!this.endpoint || !query.imdb_id && !query.tmdb_id) return [];
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set("imdb_id", query.imdb_id ?? "");
      url.searchParams.set("tmdb_id", query.tmdb_id ?? "");
      if (query.season !== void 0) url.searchParams.set("season", String(query.season));
      if (query.episode !== void 0) url.searchParams.set("episode", String(query.episode));
      url.searchParams.set("languages", requestedLanguage ?? "ara,fra,eng,spa,deu,ita,tur,por,rus,nld,pol,kor,jpn");
      const headers = { accept: "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return [];
      const payload = JSON.parse(await readTextLimited(response));
      return (payload.subtitles ?? []).map((item) => {
        const lang = LANGUAGE_MAP[(item.lang ?? item.language ?? "").toLowerCase()] ?? "";
        return lang && item.url && !existing.has(lang) ? { lang, label: item.label ?? LANGUAGE_LABELS[lang] ?? lang, isDefault: lang === "ara" && !existing.has("ara"), url: item.url, source: "opensubtitles" } : void 0;
      }).filter(Boolean);
    } catch {
      return [];
    }
  }
};
var OpenSubtitlesClient = class {
  constructor(apiKey = process.env.OPENSUBTITLES_API_KEY, baseUrl = "https://api.opensubtitles.com/api/v1", timeoutMs = 4e3, fallback = new ConfiguredSubtitleProvider()) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fallback = fallback;
  }
  apiKey;
  baseUrl;
  timeoutMs;
  fallback;
  async searchCore(query, existing, preferred) {
    const preferredLanguages = preferred?.map((language) => language.toLowerCase()).filter((language) => LANGUAGE_MAP[language]) ?? [];
    const languages = [...new Set(preferredLanguages.length ? preferredLanguages : ["ar", "fr", "en"])];
    for (const language of languages) {
      const tracks = await this.search(query, existing, language);
      if (tracks.length) return tracks;
    }
    return [];
  }
  async search(query, existing, requestedLanguage) {
    if (!this.apiKey || query.type === "music" || !query.imdb_id && !query.tmdb_id) return this.fallback.search(query, existing, requestedLanguage);
    const headers = { accept: "application/json", "Api-Key": this.apiKey, "User-Agent": "TorFlow v1.2.0" };
    const url = new URL(`${this.baseUrl}/subtitles`);
    url.searchParams.set("languages", requestedLanguage ?? "ar,en,fr,es,de,it,tr,pt,ru,nl,pl,ko,ja");
    url.searchParams.set("order_by", "download_count");
    url.searchParams.set("order_direction", "desc");
    if (query.type === "series" && query.season !== void 0 && query.episode !== void 0) {
      url.searchParams.set("season_number", String(query.season));
      url.searchParams.set("episode_number", String(query.episode));
      if (query.imdb_id) url.searchParams.set("parent_imdb_id", query.imdb_id.replace(/^tt/, ""));
      if (query.tmdb_id) url.searchParams.set("parent_tmdb_id", query.tmdb_id);
    } else if (query.imdb_id) url.searchParams.set("imdb_id", query.imdb_id.replace(/^tt/, ""));
    else if (query.tmdb_id) url.searchParams.set("tmdb_id", query.tmdb_id);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), headers });
      if (!response.ok) return this.fallback.search(query, existing, requestedLanguage);
      const payload = JSON.parse(await readTextLimited(response));
      const results = [];
      for (const item of payload.data ?? []) {
        const lang = LANGUAGE_MAP[(item.attributes?.language ?? "").toLowerCase()] ?? "";
        const file = item.attributes?.files?.[0];
        if (!lang || requestedLanguage && lang !== LANGUAGE_MAP[requestedLanguage] || !file?.file_id || existing.has(lang)) continue;
        const link = await this.download(file.file_id, headers);
        if (link) results.push({ lang, label: LANGUAGE_LABELS[lang] ?? lang, isDefault: lang === "ara" && !existing.has("ara"), url: link, source: "opensubtitles" });
      }
      const arabic = results.find((track) => track.lang === "ara");
      if (arabic) results.forEach((track) => {
        track.isDefault = track === arabic;
      });
      return results.length ? results : this.fallback.search(query, existing, requestedLanguage);
    } catch {
      return this.fallback.search(query, existing, requestedLanguage);
    }
  }
  async download(fileId, headers) {
    try {
      const response = await fetch(`${this.baseUrl}/download`, { method: "POST", signal: AbortSignal.timeout(this.timeoutMs), headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ file_id: fileId, sub_format: "vtt" }) });
      if (!response.ok) return void 0;
      return JSON.parse(await readTextLimited(response)).link;
    } catch {
      return void 0;
    }
  }
};

// src/resolver/resolution-cache.ts
var ResolutionCache = class {
  constructor(ttlMs = 36e5, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }
  ttlMs;
  maxEntries;
  entries = /* @__PURE__ */ new Map();
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return void 0;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return void 0;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  delete(key) {
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
  get size() {
    return this.entries.size;
  }
};
function resolutionCacheKey(query) {
  return JSON.stringify(Object.keys(query).sort().reduce((result, key) => {
    const value = query[key];
    if (value !== void 0 && value !== "") result[key] = value;
    return result;
  }, {}));
}

// src/resolver/hls-source.ts
var HlsSource = class {
  constructor(enabled = process.env.HLS_ENABLED === "true") {
    this.enabled = enabled;
  }
  enabled;
  resolve(query) {
    if (!this.enabled || query.preferredSource !== "hls" || !query.hlsUrl) return void 0;
    let url;
    try {
      url = new URL(query.hlsUrl);
    } catch {
      return void 0;
    }
    if (url.protocol !== "https:" || !url.pathname.toLowerCase().endsWith(".m3u8")) return void 0;
    return { sourceType: "hls", streamUrl: url.toString(), subtitles: [], quality: { resolution: "unknown", videoCodec: "unknown", audioCodec: "unknown", score: 0 } };
  }
};

// src/resolver/content-match.ts
function normalize(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function titleMatches(candidateText, requestedTitle) {
  const cleanCand = cleanTvChannelPrefixes(candidateText);
  const haystack = normalize(cleanCand);
  const needle = normalize(requestedTitle);
  if (!needle || !haystack) return false;
  if (haystack === needle || haystack.includes(needle)) {
    const idx = haystack.indexOf(needle);
    const after = haystack.slice(idx + needle.length).trim();
    const sequelMatch = after.match(/^(?:part|vol|volume)?\s*([2-9]|ii|iii|iv|v|vi|vii|viii|ix|x)\b/i);
    if (sequelMatch) {
      const reqSequel = needle.match(/\b([2-9]|ii|iii|iv|v|vi|vii|viii|ix|x)$/i);
      if (!reqSequel) return false;
    }
    return true;
  }
  const needleTokens = needle.split(" ").filter(Boolean);
  if (!needleTokens.length) return false;
  return needleTokens.every((token) => haystack.includes(token));
}
function matchesRequestedContent(query, candidateTitle, files = []) {
  const fileNames = files.flatMap((file) => [file.name, file.path]).filter((v) => Boolean(v));
  const fullText = [candidateTitle, ...fileNames].join(" ");
  const requestedTitle = query.title ?? query.query ?? "";
  if (query.type === "music") {
    const requestedParts = [query.artist, query.album, query.track, requestedTitle].filter((value) => Boolean(value?.trim()));
    if (requestedParts.length && !requestedParts.some((part) => titleMatches(fullText, part))) return false;
    if (query.artist && !titleMatches(fullText, query.artist) && query.album && !titleMatches(fullText, query.album)) return false;
    if (query.track && !titleMatches(fullText, query.track)) return false;
    return true;
  }
  if (requestedTitle && !titleMatches(fullText, requestedTitle)) {
    return false;
  }
  if (query.type === "tv_program" || isTvProgram(query)) {
    if (query.date) {
      const dateParts = query.date.split(/[-./ ]/).filter(Boolean);
      if (dateParts.length >= 2) {
        const matchesDate = dateParts.every((part) => fullText.includes(part));
        if (matchesDate) return true;
      }
    }
    if (query.season !== void 0 && (query.episode !== void 0 || query.part !== void 0)) {
      const s = query.season;
      const ep = query.episode ?? query.part;
      const seasonEpPatterns = [
        new RegExp(`s0*${s}[._\\-\\s]*e0*${ep}(?![0-9])`, "i"),
        new RegExp(`(?<![0-9])0*${s}x0*${ep}(?![0-9])`, "i"),
        new RegExp(`season[._\\-\\s]*0*${s}[._\\-\\s]+episode[._\\-\\s]*0*${ep}(?![0-9])`, "i")
      ];
      const matchesSpecific = seasonEpPatterns.some((p) => p.test(fullText));
      if (!matchesSpecific) return false;
      return true;
    }
    if (query.episode !== void 0 || query.part !== void 0) {
      const ep = query.episode ?? query.part;
      const epPattern = new RegExp(`(?:e|ep|episode|part|week|auditions)[._\\-\\s]*0*${ep}(?![0-9])`, "i");
      const standalone = new RegExp(`(?<![0-9])0*${ep}(?![0-9])`, "i");
      if (!epPattern.test(fullText) && !standalone.test(fullText)) return false;
      return true;
    }
  }
  if (query.type === "series" || query.season !== void 0 || query.episode !== void 0) {
    if (query.season === void 0 || query.episode === void 0) return false;
    const s = query.season;
    const ep = query.episode;
    const seasonEpPatterns = [
      new RegExp(`s0*${s}[._\\-\\s]*e0*${ep}(?![0-9])`, "i"),
      new RegExp(`(?<![0-9])0*${s}x0*${ep}(?![0-9])`, "i"),
      new RegExp(`season[._\\-\\s]*0*${s}[._\\-\\s]+episode[._\\-\\s]*0*${ep}(?![0-9])`, "i")
    ];
    const matchesSpecific = seasonEpPatterns.some((p) => p.test(fullText));
    if (!matchesSpecific) return false;
  }
  if (query.year) {
    const yearPattern = new RegExp(`(?<![0-9])${query.year}(?![0-9])`);
    if (!yearPattern.test(fullText)) return false;
  }
  return true;
}

// src/resolver/stream-resolver.ts
function withTimeout(promise, timeoutMs, message, onTimeout) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (onTimeout) {
        Promise.resolve(onTimeout()).catch(() => {
        });
      }
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
var resolverDebug = process.env.RESOLVER_DEBUG === "true";
var MAX_RANKED_ATTEMPTS = 16;
var StreamResolver = class {
  constructor(indexer, engine, perCandidateTimeoutMs = 5e3, subtitleClient = new OpenSubtitlesClient(), cache, hlsSource = new HlsSource()) {
    this.indexer = indexer;
    this.engine = engine;
    this.perCandidateTimeoutMs = perCandidateTimeoutMs;
    this.subtitleClient = subtitleClient;
    this.cache = cache;
    this.hlsSource = hlsSource;
  }
  indexer;
  engine;
  perCandidateTimeoutMs;
  subtitleClient;
  cache;
  hlsSource;
  inFlight = /* @__PURE__ */ new Map();
  async findStream(query) {
    if (!(query.title?.trim() || query.query?.trim() || query.artist?.trim() || query.album?.trim() || query.track?.trim() || query.imdb_id || query.tmdb_id)) {
      throw new Error("title, query, artist, album, track, imdb_id, or tmdb_id is required");
    }
    const hls = this.hlsSource.resolve(query);
    if (hls) return hls;
    const cacheKey = resolutionCacheKey(query);
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;
    const operation = this.resolveTorrent(query, cacheKey);
    this.inFlight.set(cacheKey, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }
  async resolveTorrent(query, cacheKey) {
    const cached = this.cache?.get(cacheKey);
    if (cached && this.engine.getManifest(cached.infoHash)) return { ...cached, cacheHit: true };
    if (cached) this.cache?.delete(cacheKey);
    const candidates = await withTimeout(
      this.indexer.search(query),
      Math.max(1e4, this.perCandidateTimeoutMs * 2),
      "indexer search timeout"
    );
    if (resolverDebug) {
      console.log(JSON.stringify({ scope: "resolver", event: "rank_input", type: query.type, count: candidates.length, seeders: candidates.slice(0, 10).map((candidate) => candidate.seeders) }));
    }
    const ranked = rankCandidates(candidates, query).slice(0, MAX_RANKED_ATTEMPTS);
    if (!ranked.length) {
      throw new Error(`No healthy torrent found (seeders must be >= ${query.type === "music" ? 2 : 1})`);
    }
    const failures = [];
    for (const candidate of ranked) {
      let candidateInfoHash;
      try {
        const result = await withTimeout(
          this.tryCandidate(candidate, query, (hash) => {
            candidateInfoHash = hash;
          }),
          this.perCandidateTimeoutMs,
          "candidate timeout",
          async () => {
            if (candidateInfoHash) {
              await this.engine.destroyTorrent(candidateInfoHash).catch(() => {
              });
            }
          }
        );
        const finalResult = { ...result, attempted: failures.length + 1 };
        this.cache?.set(cacheKey, finalResult);
        return finalResult;
      } catch (error) {
        if (candidateInfoHash) {
          await this.engine.destroyTorrent(candidateInfoHash).catch(() => {
          });
        }
        if (resolverDebug) {
          console.log(JSON.stringify({ scope: "resolver", event: "candidate_failure", source: candidate.source, seeders: candidate.seeders, error: String(error) }));
        }
        failures.push(`${candidate.title}: ${error.message}`);
      }
    }
    throw new Error(`All ranked torrent candidates failed: ${failures.join("; ")}`);
  }
  async tryCandidate(candidate, query, onHashRegistered) {
    let infoHash;
    try {
      const manifest = await this.engine.registerManifest({ magnet: candidate.magnet });
      infoHash = manifest.infoHash;
      if (onHashRegistered) onHashRegistered(infoHash);
      const files = Array.isArray(manifest.files) ? manifest.files : [];
      if (!manifest.infoHash || !files.length) throw new Error("Torrent metadata contains no files");
      await this.engine.waitForPeers(manifest.infoHash, Math.min(4e3, Math.max(1e3, this.perCandidateTimeoutMs - 500)));
      const file = selectMediaFile(files, query);
      if (!file) throw new Error("Torrent contains no playable media file");
      if (!matchesRequestedContent(query, `${candidate.title} ${manifest.name}`, files)) {
        throw new Error("Torrent content does not match the requested title, season, or episode");
      }
      await this.engine.verifyDataFlow(manifest.infoHash, file.index, Math.min(5e3, Math.max(1e3, this.perCandidateTimeoutMs - 250)));
      const handle = await this.engine.openStream(manifest.infoHash, file.index);
      const audioTracks = files.filter((item) => item.mimeType?.startsWith("audio/")).map((item) => item.name);
      const subtitleTracks = files.filter((item) => /\.(srt|vtt|ass|ssa)$/i.test(item.name)).map((item) => item.name);
      const local = selectSubtitleFiles(files);
      const existing = new Set(local.map((item) => item.lang));
      const subtitles = local.map((item, index) => ({
        lang: item.lang,
        label: item.label,
        isDefault: item.lang === "ara" || !existing.has("ara") && item.lang === "eng" && index === 0,
        url: `/v1/subtitles/${manifest.infoHash}/${item.file.index}`,
        source: "torrent",
        fileIndex: item.file.index
      }));
      if (query.type !== "music" && !subtitles.length) {
        try {
          const core = await withTimeout(this.subtitleClient.searchCore(query, existing, query.preferredSubtitleLanguages), 2500, "subtitle core timeout");
          subtitles.push(...core);
          if (!core.length) {
            subtitles.push(...await withTimeout(this.subtitleClient.search(query, existing), 2500, "subtitle fallback timeout"));
          }
        } catch {
        }
      }
      const defaultIndex = subtitles.findIndex((item) => item.lang === "ara");
      if (defaultIndex >= 0) {
        subtitles.forEach((item, index) => {
          item.isDefault = index === defaultIndex;
        });
      }
      return {
        sourceType: "torrent",
        subtitles,
        candidate,
        infoHash: manifest.infoHash,
        streamId: handle.streamId,
        streamUrl: `/v1/torrents/${manifest.infoHash}/files/${file.index}/stream`,
        fileIndex: file.index,
        files,
        quality: candidate.quality,
        audioTracks,
        subtitleTracks
      };
    } catch (error) {
      if (infoHash) await this.engine.destroyTorrent(infoHash);
      throw error;
    }
  }
};

// src/resolver/torznab-client.ts
function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}
function attrs(xml, name) {
  const match = xml.match(new RegExp(`<attr[^>]+name=["']${name}["'][^>]*value=["']([^"']*)["']`, "i"));
  return match?.[1] ? { value: match[1] } : {};
}
var TorznabClient = class {
  constructor(endpoint, apiKey, timeoutMs = 5e3) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }
  endpoint;
  apiKey;
  timeoutMs;
  async search(query, signal) {
    const url = new URL(this.endpoint);
    url.searchParams.set("apikey", this.apiKey);
    url.searchParams.set("t", query.season !== void 0 || query.episode !== void 0 ? "tvsearch" : "movie");
    url.searchParams.set("q", queryText(query));
    if (query.imdb_id) url.searchParams.set("imdbid", query.imdb_id.replace(/^tt/, ""));
    if (query.tmdb_id) url.searchParams.set("tmdbid", query.tmdb_id);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, { signal: combined, headers: { accept: "application/xml,text/xml" } });
    if (!response.ok) throw new Error(`Indexer responded with HTTP ${response.status}`);
    const xml = await readTextLimited(response);
    return [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map((match) => {
      const item = match[0];
      const seeders = Number(tag(item, "seeders") ?? attrs(item, "seeders").value ?? 0);
      const magnet2 = tag(item, "magneturl") ?? tag(item, "magnet") ?? tag(item, "link") ?? "";
      return { magnet: magnet2, title: tag(item, "title") ?? "untitled", seeders, leechers: Number(tag(item, "leechers") ?? 0), size: Number(tag(item, "size") ?? 0), indexer: tag(item, "indexer") };
    }).filter((candidate) => candidate.magnet.startsWith("magnet:?"));
  }
};

// src/resolver/public-clients.ts
var TRACKERS = ["udp://open.stealth.si:80/announce", "udp://tracker.opentrackr.org:1337/announce", "udp://tracker.openbittorrent.com:6969/announce", "udp://tracker.torrent.eu.org:451/announce", "udp://tracker.dler.org:6969/announce", "udp://exodus.desync.com:6969/announce"];
var resolverDebug2 = process.env.RESOLVER_DEBUG === "true";
function debug(event, data) {
  if (resolverDebug2) console.log(JSON.stringify({ scope: "resolver", event, ...data }));
}
function timeoutSignal(ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function magnet(hash, name) {
  if (!/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(hash)) return "";
  const params = [`xt=urn:btih:${hash}`, `dn=${encodeURIComponent(name)}`];
  for (const tracker of TRACKERS) params.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${params.join("&")}`;
}
function normalizeMagnet(value, name) {
  const decoded = decodeURIComponent(value);
  const match = decoded.match(/[?&]xt=urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i);
  return match?.[1] ? magnet(match[1], name) : "";
}
function isVideo(query) {
  return query.type !== "music";
}
function seriesQueryVariants(query) {
  const base = cleanQueryTerm(query.title ?? query.query ?? "") || (query.title ?? query.query ?? "");
  if (query.season === void 0 || query.episode === void 0) return [queryText(query)];
  const s = query.season;
  const e = query.episode;
  return [
    .../* @__PURE__ */ new Set([
      `${base} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`,
      `${base} S${s} E${e}`,
      `${base} Season ${s} Episode ${e}`
    ])
  ];
}
function parseTorrentioSeeders(name, title, description) {
  const text = [name, title, description].filter((value) => Boolean(value)).join("\n");
  const matches = [...text.matchAll(/(?:👤|seed(?:s|ers)?\s*[:=]?)[^0-9]{0,12}(\d+)|\b(\d+)\s*seed(?:s|ers)?\b/gi)].map((match) => Number(match[1] ?? match[2])).filter(Number.isFinite);
  return matches.length ? Math.max(...matches) : 0;
}
function parseHtmlResults(html, source, fallback) {
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  const magnetPattern = /magnet:\?[^"'<>\s]+/gi;
  for (const raw of html.match(magnetPattern) ?? []) {
    const match = raw.match(/xt=urn%3Abtih%3A([^&]+)|xt=urn:btih:([^&]+)/i);
    const hash = match?.[1] ?? match?.[2];
    if (!hash || seen.has(hash.toLowerCase())) continue;
    seen.add(hash.toLowerCase());
    const title = decodeURIComponent(raw.match(/[?&]dn=([^&]+)/i)?.[1] ?? fallback).replace(/[+]/g, " ");
    const context = html.slice(Math.max(0, html.indexOf(raw) - 180), html.indexOf(raw) + raw.length + 180);
    const seeders = Number(context.match(/(?:seed(?:s|ers)?|👤)[^0-9]{0,12}(\d+)/i)?.[1] ?? 0);
    const normalized = normalizeMagnet(raw, title);
    if (normalized) results.push({ magnet: normalized, title, seeders, source });
    if (results.length >= 500) break;
  }
  return results;
}
var YtsClient = class {
  constructor(baseUrl = "https://movies-api.accel.li/api/v2", timeoutMs = 3e3) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }
  baseUrl;
  timeoutMs;
  async search(query, signal) {
    if (query.type === "music" || query.season !== void 0 || query.episode !== void 0) return [];
    const url = new URL(`${this.baseUrl}/list_movies.json`);
    url.searchParams.set("query_term", query.imdb_id ?? query.title ?? query.query ?? "");
    url.searchParams.set("limit", "20");
    if (query.year) url.searchParams.set("year", String(query.year));
    const response = await fetch(url, { signal: timeoutSignal(this.timeoutMs, signal), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`YTS HTTP ${response.status}`);
    const payload = JSON.parse(await readTextLimited(response));
    return (payload.data?.movies ?? []).flatMap((movie) => (movie.torrents ?? []).map((torrent) => {
      const title = `${movie.title ?? query.title ?? query.query ?? ""} ${movie.year ?? query.year ?? ""} ${torrent.quality ?? ""} ${torrent.type ?? ""} x264`;
      return { magnet: torrent.hash ? magnet(torrent.hash, title) : "", title, seeders: Number(torrent.seeds ?? torrent.peers ?? 0), leechers: Number(torrent.peers ?? 0), size: Number(torrent.size_bytes ?? 0), source: "yts" };
    })).filter((candidate) => candidate.magnet);
  }
};
var TorrentioClient = class {
  constructor(baseUrl = "https://torrentio.strem.fun", timeoutMs = 3e3) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }
  baseUrl;
  timeoutMs;
  async search(query, signal) {
    if (query.type === "music") return [];
    const kind = query.season !== void 0 || query.episode !== void 0 || query.type === "series" || query.type === "tv_program" ? "series" : "movie";
    const id = query.imdb_id ?? (query.tmdb_id ? `tmdb:${query.tmdb_id}` : encodeURIComponent(query.title ?? query.query ?? ""));
    const suffix = kind === "series" ? `:${query.season ?? 1}:${query.episode ?? 1}` : "";
    const url = `${this.baseUrl}/stream/${kind}/${id}${suffix}.json`;
    let response;
    let responseBody = "";
    let lastError;
    const urls = [url];
    if (kind === "series" && query.season !== void 0 && query.episode !== void 0) {
      const padded = `${this.baseUrl}/stream/series/${id}:${String(query.season).padStart(2, "0")}:${String(query.episode).padStart(2, "0")}.json`;
      urls.push(padded);
      if (query.title || query.query) {
        const titleId = encodeURIComponent(query.title ?? query.query ?? "");
        urls.push(`${this.baseUrl}/stream/series/${titleId}:${query.season}:${query.episode}.json`);
      }
    }
    for (const requestUrl of urls) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        debug("torrentio_request_start", { url: requestUrl, attempt: attempt + 1, type: query.type ?? "movie", imdbId: query.imdb_id, season: query.season, episode: query.episode });
        try {
          response = await fetch(requestUrl, { signal: timeoutSignal(Math.max(this.timeoutMs, 8e3), signal), headers: { accept: "application/json" } });
          responseBody = await readTextLimited(response);
          debug("torrentio_response", { url: requestUrl, attempt: attempt + 1, status: response.status, bytes: responseBody.length, preview: responseBody.slice(0, 180) });
          if (response.ok) {
            try {
              const parsed = JSON.parse(responseBody);
              if ((parsed.streams ?? []).length > 0) break;
            } catch {
            }
            response = void 0;
            continue;
          }
          lastError = new Error(`Torrentio HTTP ${response.status}`);
          response = void 0;
          continue;
        } catch (error) {
          lastError = error;
          debug("torrentio_request_error", { url: requestUrl, attempt: attempt + 1, error: String(error) });
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (response?.ok) break;
    }
    if (!response?.ok) throw lastError instanceof Error ? lastError : new Error("Torrentio request failed");
    const payload = JSON.parse(responseBody);
    const candidates = (payload.streams ?? []).map((stream) => {
      const title = [stream.name, stream.title, stream.description].filter(Boolean).join("\n") || "Torrentio result";
      const hash = stream.infoHash ?? stream.url?.match(/urn:btih:([^&/]+)/i)?.[1];
      const candidateMagnet = hash ? magnet(hash, title) : stream.url?.startsWith("magnet:?") ? normalizeMagnet(stream.url, title) : "";
      const parsedSeeders = parseTorrentioSeeders(stream.name, stream.title, stream.description);
      return { magnet: candidateMagnet, title, seeders: parsedSeeders > 0 ? parsedSeeders : 1, source: "torrentio" };
    }).filter((candidate) => candidate.magnet);
    debug("torrentio_candidates", { count: candidates.length, seeders: candidates.slice(0, 10).map((candidate) => candidate.seeders) });
    return candidates;
  }
};
var HtmlTorrentClient = class {
  constructor(url, source, timeoutMs = 3e3) {
    this.url = url;
    this.source = source;
    this.timeoutMs = timeoutMs;
  }
  url;
  source;
  timeoutMs;
  async search(query, signal) {
    if (!isVideo(query)) return [];
    const variants = query.type === "tv_program" || isTvProgram(query) ? tvProgramQueryVariants(query) : seriesQueryVariants(query);
    const settled = await Promise.allSettled(variants.map(async (text) => {
      const response = await fetch(this.url(query, text), { signal: timeoutSignal(this.timeoutMs, signal), headers: { accept: "text/html,application/xhtml+xml" } });
      if (!response.ok) throw new Error(`${this.source} HTTP ${response.status}`);
      return parseHtmlResults(await readTextLimited(response), this.source, text);
    }));
    return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }
};
var X1337Client = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://1337x.to/search/${encodeURIComponent(text)}/1/`, "1337x", timeoutMs);
  }
};
var EztvClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://eztv.re/search/${encodeURIComponent(text)}`, "eztv", timeoutMs);
  }
};
var TorrentGalaxyClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(text)}`, "torrentgalaxy", timeoutMs);
  }
};
var NyaaClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(text)}`, "nyaa", timeoutMs);
  }
};
var LimeTorrentsClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://www.limetorrents.lol/search/all/${encodeURIComponent(text)}/`, "limetorrents", timeoutMs);
  }
};
var TorlockClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://www.torlock.com/all/torrents/${encodeURIComponent(text)}.html`, "torlock", timeoutMs);
  }
};
var Torrentz2Client = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://torrentz2.nz/search?f=${encodeURIComponent(text)}`, "torrentz2", timeoutMs);
  }
};
var RuTrackerClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 4e3) {
    super((_q, text) => `https://rutracker.org/forum/tracker.php?nm=${encodeURIComponent(text)}`, "rutracker", timeoutMs);
  }
};
var YggTorrentClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 4e3) {
    super((_q, text) => `https://www.yggtorrent.top/engine/search?name=${encodeURIComponent(text)}&do=search`, "yggtorrent", timeoutMs);
  }
};
var InternetArchiveClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 4e3) {
    super((_q, text) => `https://archive.org/search?query=${encodeURIComponent(text)}&and[]=format%3A%22Torrent%22`, "internet-archive", timeoutMs);
  }
};
var TorrentDownloadsClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://www.torrentdownloads.pro/search/?search=${encodeURIComponent(text)}`, "torrentdownloads", timeoutMs);
  }
};
var PsAripsClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://psarips.top/?s=${encodeURIComponent(text)}`, "psarips", timeoutMs);
  }
};
var ExtToClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://ext.to/search/?q=${encodeURIComponent(text)}`, "ext.to", timeoutMs);
  }
};
var RarbgMirrorClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://rarbg.to/torrents.php?search=${encodeURIComponent(text)}`, "rarbg-mirror", timeoutMs);
  }
};
var KickassMirrorClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://kickasstorrents.to/usearch/${encodeURIComponent(text)}/`, "kickass-mirror", timeoutMs);
  }
};
var FitGirlClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 3e3) {
    super((_q, text) => `https://fitgirl-repacks.site/?s=${encodeURIComponent(text)}`, "fitgirl", timeoutMs);
  }
};
var AcademicTorrentsClient = class extends HtmlTorrentClient {
  constructor(timeoutMs = 4e3) {
    super((_q, text) => `https://academictorrents.com/browse.php?search=${encodeURIComponent(text)}`, "academic-torrents", timeoutMs);
  }
};
var LinuxDistroClient = class {
  constructor(timeoutMs = 4e3) {
    this.timeoutMs = timeoutMs;
  }
  timeoutMs;
  keywords = ["ubuntu", "debian", "fedora", "arch linux", "archlinux", "linux mint", "linuxmint", "rocky linux", "rockylinux", "almalinux", "opensuse", "open suse"];
  async search(query, signal) {
    const text = (query.title ?? query.query ?? "").toLowerCase();
    const isDistro = this.keywords.some((k) => text.includes(k)) || /\b(iso|linux)\b/i.test(text);
    if (!isDistro) return [];
    const searchText = `${queryText(query)} iso`;
    const clients = [
      new HtmlTorrentClient((_q, t) => `https://www.limetorrents.lol/search/all/${encodeURIComponent(t)}/`, "linux-limetorrents", this.timeoutMs),
      new HtmlTorrentClient((_q, t) => `https://1337x.to/search/${encodeURIComponent(t)}/1/`, "linux-1337x", this.timeoutMs),
      new HtmlTorrentClient((_q, t) => `https://archive.org/search?query=${encodeURIComponent(t)}+format%3ATorrent`, "linux-archive", this.timeoutMs)
    ];
    const settled = await Promise.allSettled(clients.map((c) => c.search({ ...query, query: searchText, title: searchText }, signal)));
    return settled.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  }
};
var ApibayVideoClient = class {
  constructor(baseUrl = "https://apibay.org", timeoutMs = 3e3) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }
  baseUrl;
  timeoutMs;
  async search(query, signal) {
    if (query.type === "music") return [];
    const textVariants = query.type === "tv_program" || isTvProgram(query) ? tvProgramQueryVariants(query) : seriesQueryVariants(query);
    const primary = queryText(query);
    const searchTerms = [.../* @__PURE__ */ new Set([primary, ...textVariants])];
    const search = async (term) => {
      try {
        const response = await fetch(`${this.baseUrl}/q.php?q=${encodeURIComponent(term)}&cat=200`, {
          signal: timeoutSignal(this.timeoutMs, signal),
          headers: { accept: "application/json" }
        });
        if (!response.ok) return [];
        const payload = await response.json();
        if (!Array.isArray(payload)) return [];
        return payload.filter((item) => item.name && item.name !== "No results returned" && item.info_hash).map((item) => ({
          magnet: magnet(item.info_hash, item.name),
          title: item.name,
          seeders: Number(item.seeders ?? 0),
          leechers: Number(item.leechers ?? 0),
          size: Number(item.size ?? 0),
          source: "apibay"
        })).filter((c) => c.magnet);
      } catch {
        return [];
      }
    };
    const all = [];
    for (const term of searchTerms) {
      const candidates = await search(term);
      all.push(...candidates);
      if (all.some((c) => c.seeders >= 5)) break;
    }
    return all;
  }
};
var AudioPublicClient = class {
  constructor(baseUrl = "https://apibay.org", timeoutMs = 3e3) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }
  baseUrl;
  timeoutMs;
  async search(query, signal) {
    if (query.type !== "music") return [];
    const detailed = queryText(query);
    const terms = [...new Set([detailed, [query.artist, query.album, query.track, query.query].filter(Boolean).join(" "), query.track, query.album, query.artist].filter((value) => Boolean(value)))];
    const search = async (text) => {
      const response = await fetch(`${this.baseUrl}/q.php?q=${encodeURIComponent(text)}`, { signal: timeoutSignal(this.timeoutMs, signal), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Audio indexer HTTP ${response.status}`);
      const payload = JSON.parse(await readTextLimited(response));
      return payload.map((item) => {
        const title = item.name ?? text;
        return { magnet: item.info_hash ? magnet(item.info_hash, title) : "", title, seeders: Number(item.seeders ?? 0), leechers: Number(item.leechers ?? 0), size: Number(item.size ?? 0), source: "public-audio" };
      }).filter((candidate) => candidate.magnet);
    };
    const all = [];
    for (const term of terms) {
      const found = await search(term);
      all.push(...found);
      if (found.some((candidate) => candidate.seeders >= 2)) break;
    }
    return all;
  }
};
var MultiIndexerClient = class {
  constructor(clients) {
    this.clients = clients;
  }
  clients;
  async search(query, signal) {
    const settled = await Promise.allSettled(this.clients.map((client) => client.search(query, signal)));
    const results = settled.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        debug("indexer_result", { index, count: result.value.length, seeders: result.value.slice(0, 5).map((candidate) => candidate.seeders) });
        return result.value;
      }
      debug("indexer_error", { index, error: String(result.reason) });
      return [];
    });
    debug("indexer_aggregate", { count: results.length });
    return results;
  }
};
function createPublicIndexer(timeoutMs = 3e3) {
  return new MultiIndexerClient([
    new YtsClient(void 0, timeoutMs),
    new TorrentioClient(void 0, timeoutMs),
    new ApibayVideoClient(void 0, timeoutMs),
    new X1337Client(timeoutMs),
    new EztvClient(timeoutMs),
    new TorrentGalaxyClient(timeoutMs),
    new AudioPublicClient(void 0, timeoutMs),
    // المصادر الجديدة
    new NyaaClient(timeoutMs),
    new LimeTorrentsClient(timeoutMs),
    new TorlockClient(timeoutMs),
    new Torrentz2Client(timeoutMs),
    new RuTrackerClient(timeoutMs),
    new YggTorrentClient(timeoutMs),
    new InternetArchiveClient(timeoutMs),
    new TorrentDownloadsClient(timeoutMs),
    new PsAripsClient(timeoutMs),
    new ExtToClient(timeoutMs),
    new RarbgMirrorClient(timeoutMs),
    new KickassMirrorClient(timeoutMs),
    new FitGirlClient(timeoutMs),
    new AcademicTorrentsClient(timeoutMs),
    new LinuxDistroClient(timeoutMs)
  ]);
}

// src/server.ts
async function buildApp() {
  const config = loadConfig();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info" },
    bodyLimit: 1048576
  });
  const metrics = { startedAt: Date.now(), total: 0, errors: 0, byStatus: {}, lastLatencyMs: 0, countries: /* @__PURE__ */ new Map() };
  const requestTracker = new RequestTracker();
  const requestStartedAt = /* @__PURE__ */ new WeakMap();
  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, Date.now());
    if (!request.url.startsWith("/admin") && request.url !== "/health" && request.url !== "/ready") {
      const header = request.headers["x-vercel-ip-country"] ?? request.headers["cf-ipcountry"];
      const country = typeof header === "string" && /^[A-Za-z]{2}$/.test(header) ? header.toUpperCase() : "UNKNOWN";
      metrics.countries.set(country, (metrics.countries.get(country) ?? 0) + 1);
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    metrics.total += 1;
    metrics.lastLatencyMs = Date.now() - (requestStartedAt.get(request) ?? Date.now());
    const status = String(reply.statusCode);
    metrics.byStatus[status] = (metrics.byStatus[status] ?? 0) + 1;
    if (reply.statusCode >= 500) metrics.errors += 1;
  });
  const rateBuckets = /* @__PURE__ */ new Map();
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.url === "/health" || request.url === "/ready" || request.url === "/admin" || request.url.startsWith("/admin/api/")) return;
    if (config.apiKey && request.headers["x-api-key"] !== config.apiKey) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const forwarded = request.headers["x-forwarded-for"];
    const clientKey = (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : void 0) || request.ip || "unknown";
    const now = Date.now();
    const bucket = rateBuckets.get(clientKey);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(clientKey, { count: 1, resetAt: now + config.rateLimitWindowMs });
      return;
    }
    bucket.count += 1;
    reply.header("RateLimit-Limit", config.rateLimitMax);
    reply.header("RateLimit-Remaining", Math.max(0, config.rateLimitMax - bucket.count));
    reply.header("RateLimit-Reset", Math.ceil((bucket.resetAt - now) / 1e3));
    if (bucket.count > config.rateLimitMax) {
      return reply.code(429).send({ error: "Rate limit exceeded", retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1e3) });
    }
    if (rateBuckets.size > 1e4) {
      for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const isProd = config.nodeEnv === "production";
    const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 500;
    const response = {
      error: error?.name || "InternalServerError",
      statusCode
    };
    if (!isProd) {
      response.message = error?.message;
    } else if (statusCode < 500) {
      response.message = error?.message;
    } else {
      response.message = "Internal server error";
    }
    reply.code(statusCode).send(response);
  });
  await app.register(cors, {
    origin: config.allowedOrigins.includes("*") ? true : config.allowedOrigins.length ? config.allowedOrigins : false,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false
  });
  await app.register(helmet);
  await app.register(sensible);
  const cache = new CacheManager(config.cacheDir, config.cacheMaxBytes, config.cacheTtlSeconds * 1e3);
  await cache.init();
  const engine = new TorrentEngine(void 0, {
    maxConcurrentTorrents: config.maxConcurrentTorrents,
    idleTorrentGracePeriodMs: process.env.NODE_ENV === "test" ? 1e3 : 3e4
  });
  const publicIndexer = createPublicIndexer(Math.min(config.resolverTimeoutMs, 5e3));
  const indexer = config.indexerUrl && config.indexerApiKey ? new MultiIndexerClient([publicIndexer, new TorznabClient(config.indexerUrl, config.indexerApiKey, config.resolverTimeoutMs)]) : publicIndexer;
  const resolutionCache = config.resolutionCacheEnabled ? new ResolutionCache(Math.min(config.resolutionCacheTtlSeconds, 7200) * 1e3, config.resolutionCacheMaxEntries) : void 0;
  const resolver = new StreamResolver(
    indexer,
    engine,
    Math.min(config.resolverTimeoutMs, 15e3),
    new OpenSubtitlesClient(config.openSubtitlesApiKey),
    resolutionCache,
    new HlsSource()
  );
  await registerRoutes(app, engine, resolver, { apiKey: config.apiKey, adminKey: config.adminKey, metrics, requestTracker, config });
  app.decorate("streamix", { engine, cache, config });
  return app;
}
async function gracefulShutdown(app) {
  const streamix = app.streamix;
  if (streamix?.engine) {
    await streamix.engine.destroy();
  }
  await app.close();
}
if (process.env.VERCEL !== "1" && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = await buildApp();
  const shutdown = async (signal) => {
    app.log.info({ signal }, "Received shutdown signal, starting graceful shutdown...");
    try {
      await gracefulShutdown(app);
      process.exit(0);
    } catch (err) {
      app.log.error(err, "Error during graceful shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await app.listen({ host: config.host, port: config.port });
}

// api/index.ts
var appPromise = buildApp();
async function handler(req, res) {
  const app = await appPromise;
  await app.ready();
  app.server.emit("request", req, res);
}
export {
  handler as default
};
