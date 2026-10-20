import 'dotenv/config';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  nodeEnv: string;
  cacheDir: string;
  cacheMaxBytes: number;
  cacheTtlSeconds: number;
  maxConcurrentTorrents: number;
  maxActiveStreams: number;
  maxTorrentBytes: number;
  allowedOrigins: string[];
  indexerUrl?: string;
  indexerApiKey?: string;
  resolverTimeoutMs: number;
  openSubtitlesApiKey?: string;
  resolutionCacheEnabled: boolean;
  resolutionCacheTtlSeconds: number;
  resolutionCacheMaxEntries: number;
  resolverDebug: boolean;
  apiKey?: string;
  adminKey?: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function loadConfig(env = process.env): AppConfig {
  const origins = env.ALLOWED_ORIGINS ?? env.CORS_ORIGIN ?? '';
  const isVercel = env.VERCEL === '1' || env.VERCEL === 'true';
  return {
    host: env.HOST || '0.0.0.0',
    port: boundedNumber(env.PORT, 8080, 1, 65535),
    nodeEnv: env.NODE_ENV || (isVercel ? 'production' : 'development'),
    cacheDir: path.resolve(env.CACHE_DIR || (isVercel ? '/tmp/torflow-cache' : '.cache')),
    cacheMaxBytes: boundedNumber(env.CACHE_MAX_BYTES, 2_147_483_648, 1_048_576, 20_000_000_000),
    cacheTtlSeconds: boundedNumber(env.CACHE_TTL_SECONDS, 3600, 60, 86_400),
    maxConcurrentTorrents: boundedNumber(env.MAX_CONCURRENT_TORRENTS, 4, 1, 100),
    maxActiveStreams: boundedNumber(env.MAX_ACTIVE_STREAMS, 50, 1, 2_000),
    maxTorrentBytes: boundedNumber(env.MAX_TORRENT_SIZE_BYTES, 500_000_000_000, 1_048_576, 2_000_000_000_000),
    allowedOrigins: origins.split(',').map((origin) => origin.trim()).filter(Boolean),
    indexerUrl: env.INDEXER_URL,
    indexerApiKey: env.INDEXER_API_KEY,
    resolverTimeoutMs: boundedNumber(env.RESOLVER_TIMEOUT_MS, 45_000, 500, 45_000),
    openSubtitlesApiKey: env.OPENSUBTITLES_API_KEY,
    resolutionCacheEnabled: env.RESOLUTION_CACHE_ENABLED !== 'false',
    resolutionCacheTtlSeconds: boundedNumber(env.RESOLUTION_CACHE_TTL_SECONDS, 3600, 60, 7200),
    resolutionCacheMaxEntries: boundedNumber(env.RESOLUTION_CACHE_MAX_ENTRIES, 500, 1, 50_000),
    resolverDebug: env.RESOLVER_DEBUG === 'true' && env.NODE_ENV !== 'production',
    apiKey: env.TORFLOW_API_KEY || undefined,
    adminKey: env.TORFLOW_ADMIN_KEY || env.TORFLOW_API_KEY || undefined,
    rateLimitWindowMs: boundedNumber(env.RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000),
    rateLimitMax: boundedNumber(env.RATE_LIMIT_MAX, 60, 1, 100_000),
  };
}
