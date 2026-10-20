import { FastifyReply, FastifyRequest } from 'fastify';
import { StreamResolver } from '../resolver/stream-resolver.js';
import { ResolverQuery } from '../resolver/types.js';

export function resolverController(resolver?: StreamResolver) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!resolver) return reply.code(503).send({ error: 'Resolver is temporarily unavailable' });
    const query = request.body as ResolverQuery;
    try {
      const result = await resolver.findStream(query);
      return reply.send({ data: result });
    } catch (error) {
      const message = (error as Error).message;
      const status = /required|invalid|must be|malformed/i.test(message) ? 400 : /timeout|timed out|no active peers|swarm/i.test(message) ? 504 : 404;
      const code = status === 400 ? 'INVALID_QUERY' : status === 504 ? 'SWARM_TIMEOUT' : 'NO_HEALTHY_TORRENT';
      return reply.code(status).send({ error: message, code });
    }
  };
}
