import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { loadConfig } from './config.js';
import { CacheManager } from './engine/cache-manager.js';
import { TorrentEngine } from './engine/torrent-engine.js';
import { registerRoutes } from './routes/index.js';
import { StreamResolver } from './resolver/stream-resolver.js';
import { TorznabClient } from './resolver/torznab-client.js';
import { MultiIndexerClient, createPublicIndexer } from './resolver/public-clients.js';
import { OpenSubtitlesClient } from './resolver/subtitles.js';
import { ResolutionCache } from './resolver/resolution-cache.js';
import { ResolverResult } from './resolver/types.js';
import { HlsSource } from './resolver/hls-source.js';

export async function buildApp() {
  const config = loadConfig();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  // Custom error handler to prevent leaking sensitive stack traces in production
  app.setErrorHandler((error: any, request, reply) => {
    const isProd = config.nodeEnv === 'production';
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    const response: { error: string; statusCode: number; code?: string; message?: string } = {
      error: error?.name || 'InternalServerError',
      statusCode
    };
    if (!isProd) {
      response.message = error?.message;
    } else if (statusCode < 500) {
      response.message = error?.message;
    } else {
      response.message = 'Internal server error';
    }
    reply.code(statusCode).send(response);
  });

  await app.register(cors, {
    origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });
  await app.register(helmet);
  await app.register(sensible);

  const cache = new CacheManager(config.cacheDir, config.cacheMaxBytes, config.cacheTtlSeconds * 1000);
  await cache.init();

  const engine = new TorrentEngine(undefined, {
    maxConcurrentTorrents: config.maxConcurrentTorrents,
    idleTorrentGracePeriodMs: process.env.NODE_ENV === 'test' ? 1000 : 30_000
  });

  const publicIndexer = createPublicIndexer(Math.min(config.resolverTimeoutMs, 5000));
  const indexer = config.indexerUrl && config.indexerApiKey
    ? new MultiIndexerClient([publicIndexer, new TorznabClient(config.indexerUrl, config.indexerApiKey, config.resolverTimeoutMs)])
    : publicIndexer;

  const resolutionCache = config.resolutionCacheEnabled
    ? new ResolutionCache<ResolverResult>(Math.min(config.resolutionCacheTtlSeconds, 7200) * 1000, config.resolutionCacheMaxEntries)
    : undefined;

  const resolver = new StreamResolver(
    indexer,
    engine,
    Math.min(config.resolverTimeoutMs, 15000),
    new OpenSubtitlesClient(config.openSubtitlesApiKey),
    resolutionCache,
    new HlsSource()
  );

  await registerRoutes(app, engine, resolver);
  app.decorate('streamix', { engine, cache, config });

  return app;
}

export async function gracefulShutdown(app: FastifyInstance): Promise<void> {
  const streamix = (app as unknown as { streamix?: { engine: TorrentEngine } }).streamix;
  if (streamix?.engine) {
    await streamix.engine.destroy();
  }
  await app.close();
}

if (process.env.VERCEL !== '1' && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');
    try {
      await gracefulShutdown(app);
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}
