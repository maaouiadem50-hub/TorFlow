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
  allowedOrigins: string[];
  indexerUrl?: string;
  indexerApiKey?: string;
  resolverTimeoutMs: number;
  openSubtitlesApiKey?: string;
  resolutionCacheEnabled: boolean;
  resolutionCacheTtlSeconds: number;
  resolutionCacheMaxEntries: number;
  resolverDebug: boolean;
}

export function loadConfig(env = process.env): AppConfig {
  const origins = env.ALLOWED_ORIGINS ?? env.CORS_ORIGIN ?? '*';
  return {
    host: env.HOST || '0.0.0.0', port: Number(env.PORT || 8080), nodeEnv: env.NODE_ENV || 'development',
    cacheDir: path.resolve(env.CACHE_DIR || (env.VERCEL ? '/tmp/torflow-cache' : '.cache')), cacheMaxBytes: Number(env.CACHE_MAX_BYTES || 2_147_483_648), cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS || 3600), maxConcurrentTorrents: Number(env.MAX_CONCURRENT_TORRENTS || 4),
    allowedOrigins: origins.split(',').map((origin) => origin.trim()).filter(Boolean),
    indexerUrl: env.INDEXER_URL, indexerApiKey: env.INDEXER_API_KEY, resolverTimeoutMs: Math.min(Number(env.RESOLVER_TIMEOUT_MS ?? 45000), 45000), openSubtitlesApiKey: env.OPENSUBTITLES_API_KEY,
    resolutionCacheEnabled: env.RESOLUTION_CACHE_ENABLED !== 'false', resolutionCacheTtlSeconds: Math.min(Math.max(Number(env.RESOLUTION_CACHE_TTL_SECONDS ?? 3600), 60), 7200), resolutionCacheMaxEntries: Math.max(Number(env.RESOLUTION_CACHE_MAX_ENTRIES ?? 500), 1), resolverDebug: env.RESOLVER_DEBUG === 'true',
  };
}
