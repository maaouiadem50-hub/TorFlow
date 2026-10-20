import { FastifyInstance } from 'fastify';
import { metadataController } from '../controllers/metadata-controller.js';
import { resolverController } from '../controllers/resolver-controller.js';
import { statusController, streamController } from '../controllers/stream-controller.js';
import { subtitleController } from '../controllers/subtitle-controller.js';
import { TorrentEngine } from '../engine/torrent-engine.js';
import { StreamResolver } from '../resolver/stream-resolver.js';

export async function registerRoutes(app: FastifyInstance, engine: TorrentEngine, resolver?: StreamResolver): Promise<void> {
  app.get('/health', async (_request, reply) => reply.header('Cache-Control', 'no-store').send({ status: 'ok', service: 'torflow' }));
  app.get('/ready', async (_request, reply) => reply.header('Cache-Control', 'no-store').send({ status: 'ready', service: 'torflow' }));
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
