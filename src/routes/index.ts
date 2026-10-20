import { FastifyInstance } from 'fastify';
import { metadataController } from '../controllers/metadata-controller.js';
import { resolverController } from '../controllers/resolver-controller.js';
import { statusController, streamController } from '../controllers/stream-controller.js';
import { subtitleController } from '../controllers/subtitle-controller.js';
import { TorrentEngine } from '../engine/torrent-engine.js';
import { StreamResolver } from '../resolver/stream-resolver.js';
import { adminDashboardHtml } from '../admin-dashboard.js';

type RuntimeMetrics = { startedAt: number; total: number; errors: number; byStatus: Record<string, number>; lastLatencyMs: number; countries: Map<string, number> };
type RouteOptions = { apiKey?: string; adminKey?: string; metrics: RuntimeMetrics; config: { nodeEnv: string; maxConcurrentTorrents: number; resolverTimeoutMs: number; cacheMaxBytes: number; cacheTtlSeconds: number } };

export async function registerRoutes(app: FastifyInstance, engine: TorrentEngine, resolver?: StreamResolver, options?: RouteOptions): Promise<void> {
  const runtime = options ?? { metrics: { startedAt: Date.now(), total: 0, errors: 0, byStatus: {}, lastLatencyMs: 0, countries: new Map<string, number>() }, config: { nodeEnv: 'development', maxConcurrentTorrents: 4, resolverTimeoutMs: 15000, cacheMaxBytes: 0, cacheTtlSeconds: 0 } };
  const adminGuard = async (request: any, reply: any): Promise<boolean> => {
    if (!runtime.adminKey) { reply.code(503).send({ error: 'Admin authentication is not configured' }); return false; }
    if (request.headers['x-api-key'] !== runtime.adminKey) { reply.code(401).send({ error: 'Unauthorized' }); return false; }
    return true;
  };
  app.get('/health', async (_request, reply) => reply.header('Cache-Control', 'no-store').send({ status: 'ok', service: 'torflow' }));
  app.get('/ready', async (_request, reply) => reply.header('Cache-Control', 'no-store').send({ status: 'ready', service: 'torflow' }));
  app.get('/admin', async (_request, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(adminDashboardHtml()));
  app.get('/admin/api/overview', async (request, reply) => {
    if (!await adminGuard(request, reply)) return;
    const snapshot = engine.getAdminSnapshot();
    const memory = process.memoryUsage();
    const total = runtime.metrics.total;
    const countryTotal = [...runtime.metrics.countries.values()].reduce((sum, count) => sum + count, 0);
    const countries = [...runtime.metrics.countries.entries()].map(([country, count]) => ({ country, requests: count, percentage: countryTotal ? Number((count / countryTotal * 100).toFixed(2)) : 0 })).sort((a, b) => b.requests - a.requests);
    return reply.header('Cache-Control', 'no-store').send({
      service: { status: 'ok', environment: runtime.config.nodeEnv },
      runtime: { uptimeSeconds: process.uptime(), version: process.env.npm_package_version ?? 'unknown', node: process.version, memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external } },
      engine: { activeTorrents: snapshot.torrents.length, activeStreams: snapshot.streams.length, maxConcurrentTorrents: runtime.config.maxConcurrentTorrents },
      requests: { total, errors: runtime.metrics.errors, errorRate: total ? runtime.metrics.errors / total : 0, lastLatencyMs: runtime.metrics.lastLatencyMs, byStatus: runtime.metrics.byStatus },
      countries: { scope: 'observed requests on this running instance', uniqueUsers: false, totalObserved: countryTotal, data: countries },
      config: { resolverTimeoutMs: runtime.config.resolverTimeoutMs, cacheMaxBytes: runtime.config.cacheMaxBytes, cacheTtlSeconds: runtime.config.cacheTtlSeconds }
    });
  });
  app.get('/admin/api/torrents', async (request, reply) => {
    if (!await adminGuard(request, reply)) return;
    return reply.header('Cache-Control', 'no-store').send({ data: engine.getAdminSnapshot().torrents });
  });
  app.get('/admin/api/streams', async (request, reply) => {
    if (!await adminGuard(request, reply)) return;
    const snapshot = engine.getAdminSnapshot();
    const data = snapshot.streams.map((stream) => ({ ...stream, fileName: engine.getManifest(stream.infoHash)?.files[stream.fileIndex]?.name ?? `file-${stream.fileIndex}` }));
    return reply.header('Cache-Control', 'no-store').send({ data });
  });
  app.post('/v1/metadata/inspect', { schema: { body: { type: 'object', required: ['magnet'], additionalProperties: false, properties: { magnet: { type: 'string', minLength: 20, maxLength: 4096 } } } } }, metadataController(engine));
  app.post('/v1/resolver/find-stream', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        anyOf: [{ required: ['title'] }, { required: ['query'] }, { required: ['artist'] }, { required: ['album'] }, { required: ['track'] }, { required: ['imdb_id'] }, { required: ['tmdb_id'] }],
        properties: {
          type: { type: 'string', enum: ['movie', 'series', 'music', 'tv_program'] },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          query: { type: 'string', minLength: 1, maxLength: 500 },
          artist: { type: 'string', minLength: 1, maxLength: 200 },
          album: { type: 'string', minLength: 1, maxLength: 200 },
          track: { type: 'string', minLength: 1, maxLength: 200 },
          year: { type: 'integer', minimum: 1800, maximum: 2200 },
          season: { type: 'integer', minimum: 0, maximum: 1000 },
          episode: { type: 'integer', minimum: 0, maximum: 10000 },
          date: { type: 'string', maxLength: 40 },
          network: { type: 'string', maxLength: 120 },
          country: { type: 'string', maxLength: 80 },
          part: { type: 'integer', minimum: 0, maximum: 10000 },
          imdb_id: { type: 'string', pattern: '^tt[0-9]{3,12}$' },
          tmdb_id: { type: 'string', pattern: '^[0-9]{1,12}$' },
          preferredQuality: { type: 'string', enum: ['2160p', '1080p', '720p', '480p'] },
          preferredSubtitleLanguages: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 2, maxLength: 12 } },
          preferredSource: { type: 'string', enum: ['torrent', 'hls', 'auto'] },
          hlsUrl: { type: 'string', format: 'uri', maxLength: 2048 }
        }
      }
    }
  }, resolverController(resolver));

  const torrentParams = { type: 'object', required: ['infoHash'], additionalProperties: false, properties: { infoHash: { type: 'string', pattern: '^(?:[a-fA-F0-9]{40}|[A-Z2-7a-z2-7]{32})$' } } } as const;
  const streamParams = { type: 'object', required: ['infoHash', 'fileIndex'], additionalProperties: false, properties: { ...torrentParams.properties, fileIndex: { type: 'string', pattern: '^(?:0|[1-9][0-9]{0,5})$' } } } as const;
  const streamIdParams = { type: 'object', required: ['streamId'], additionalProperties: false, properties: { streamId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } } } as const;

  app.get('/v1/torrents/:infoHash', { schema: { params: torrentParams } }, async (request, reply) => {
    const data = engine.getManifest((request.params as { infoHash: string }).infoHash);
    return data ? reply.send({ data }) : reply.code(404).send({ error: 'Metadata not found' });
  });

  app.get('/v1/torrents/:infoHash/files/:fileIndex/stream', { schema: { params: streamParams } }, streamController(engine));
  app.get('/v1/subtitles/:infoHash/:fileIndex', { schema: { params: streamParams } }, subtitleController(engine));
  app.get('/v1/streams/:streamId/status', { schema: { params: streamIdParams } }, statusController(engine));
  app.get('/v1/streams/:streamId/events', { schema: { params: streamIdParams } }, async (request, reply) => {
    const id = (request.params as { streamId: string }).streamId;
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const listener = (event: unknown) => {
      if ((event as { streamId?: string }).streamId === id) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    engine.on('status', listener);
    request.raw.on('close', () => {
      engine.off('status', listener);
    });
  });
}
