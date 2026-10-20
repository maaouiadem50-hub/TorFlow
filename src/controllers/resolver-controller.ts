import { FastifyReply, FastifyRequest } from 'fastify';
import { StreamResolver } from '../resolver/stream-resolver.js';
import { ResolverQuery } from '../resolver/types.js';
import { randomUUID } from 'node:crypto';
import { RequestTracker } from '../observability/request-tracker.js';

export function resolverController(resolver?: StreamResolver, tracker?: RequestTracker) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!resolver) return reply.code(503).send({ error: 'Resolver is temporarily unavailable' });
    const query = request.body as ResolverQuery;
    const requestId = randomUUID();
    const trace = tracker?.start({ requestId, route: (request.url ?? '/').split('?')[0] ?? '/', method: request.method, requestType: query.type ?? 'unknown' });
    const receivedAt = trace?.receivedAt ?? new Date().toISOString();
    reply.header('x-request-id', requestId);
    try {
      const result = await resolver.findStream(query);
      const subtitles = 'subtitles' in result ? result.subtitles : [];
      const quality = 'quality' in result ? result.quality : undefined;
      const diagnostics = { requestId, receivedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status: 'completed' as const, phase: 'completed', attempted: 'attempted' in result ? result.attempted : undefined, source: 'candidate' in result ? result.candidate.source : 'hls', cacheHit: 'cacheHit' in result ? result.cacheHit : false, subtitleStatus: subtitles.length ? 'found' as const : 'not_found' as const, subtitleLanguages: subtitles.map((item) => item.lang), qualityStatus: quality?.resolution && quality.resolution !== 'unknown' ? 'found' as const : 'unknown' as const, quality: quality?.resolution };
      const { requestId: _completedRequestId, ...completedTrace } = diagnostics;
      tracker?.finish(requestId, completedTrace);
      return reply.send({ requestId, diagnostics, data: result });
    } catch (error) {
      const message = (error as Error).message;
      const status = /required|invalid query|malformed/i.test(message) ? 400 : /timeout|timed out|no active peers|swarm/i.test(message) ? 504 : 404;
      const code = status === 400 ? 'INVALID_QUERY' : status === 504 ? 'SWARM_TIMEOUT' : 'NO_HEALTHY_TORRENT';
      const state = status === 504 ? 'timeout' as const : 'failed' as const;
      const diagnostics = { requestId, receivedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status: state, phase: state, httpStatus: status, errorCode: code, errorMessage: message };
      const { requestId: _failedRequestId, ...failedTrace } = diagnostics;
      tracker?.finish(requestId, failedTrace);
      return reply.code(status).send({ requestId, diagnostics, error: message, code });
    }
  };
}
