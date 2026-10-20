import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { loadConfig } from './config.js';
import { CacheManager } from './engine/cache-manager.js';
import { TorrentEngine } from './engine/torrent-engine.js';
import { registerRoutes } from './routes/index.js';
import { RequestTracker } from './observability/request-tracker.js';
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
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 1_048_576,
  });

  const metrics = { startedAt: Date.now(), total: 0, errors: 0, byStatus: {} as Record<string, number>, lastLatencyMs: 0, countries: new Map<string, number>() };
  const requestTracker = new RequestTracker();
  const requestStartedAt = new WeakMap<object, number>();
  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, Date.now());
    if (!request.url.startsWith('/admin') && request.url !== '/health' && request.url !== '/ready') {
      const header = request.headers['x-vercel-ip-country'] ?? request.headers['cf-ipcountry'];
      const country = typeof header === 'string' && /^[A-Za-z]{2}$/.test(header) ? header.toUpperCase() : 'UNKNOWN';
      metrics.countries.set(country, (metrics.countries.get(country) ?? 0) + 1);
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    metrics.total += 1;
    metrics.lastLatencyMs = Date.now() - (requestStartedAt.get(request) ?? Date.now());
    const status = String(reply.statusCode);
    metrics.byStatus[status] = (metrics.byStatus[status] ?? 0) + 1;
    if (reply.statusCode >= 500) metrics.errors += 1;
  });

  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url === '/health' || request.url === '/ready' || request.url === '/admin' || request.url.startsWith('/admin/api/')) return;

    if (config.apiKey && request.headers['x-api-key'] !== config.apiKey) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const forwarded = request.headers['x-forwarded-for'];
    const clientKey = (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) || request.ip || 'unknown';
    const now = Date.now();
    const bucket = rateBuckets.get(clientKey);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(clientKey, { count: 1, resetAt: now + config.rateLimitWindowMs });
      return;
    }
    bucket.count += 1;
    reply.header('RateLimit-Limit', config.rateLimitMax);
    reply.header('RateLimit-Remaining', Math.max(0, config.rateLimitMax - bucket.count));
    reply.header('RateLimit-Reset', Math.ceil((bucket.resetAt - now) / 1000));
    if (bucket.count > config.rateLimitMax) {
      return reply.code(429).send({ error: 'Rate limit exceeded', retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) });
    }
    if (rateBuckets.size > 10_000) {
      for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key);
    }
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
    origin: config.allowedOrigins.includes('*') ? true : (config.allowedOrigins.length ? config.allowedOrigins : false),
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

  await registerRoutes(app, engine, resolver, { apiKey: config.apiKey, adminKey: config.adminKey, metrics, requestTracker, config });
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
