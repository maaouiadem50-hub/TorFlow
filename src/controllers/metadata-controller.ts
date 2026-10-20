import { FastifyReply, FastifyRequest } from 'fastify';
import { TorrentEngine } from '../engine/torrent-engine.js';

const MAX_TORRENT_UPLOAD_BYTES = 2 * 1024 * 1024;

function decodeTorrentBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || normalized.length > Math.ceil(MAX_TORRENT_UPLOAD_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Invalid torrentBase64 payload');
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length || buffer.length > MAX_TORRENT_UPLOAD_BYTES) {
    throw new Error(`Torrent upload exceeds maximum size (${MAX_TORRENT_UPLOAD_BYTES} bytes)`);
  }
  return buffer;
}

export function metadataController(engine: TorrentEngine) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { magnet?: string; torrentBase64?: string } | undefined;
    const torrent = (request as FastifyRequest & { file?: { buffer: Buffer } }).file;
    if (!body?.magnet && !body?.torrentBase64 && !torrent?.buffer) return reply.code(400).send({ error: 'Provide magnet, torrentBase64, or torrent upload' });
    try {
      const source = body?.magnet
        ? { magnet: body.magnet }
        : { torrentBuffer: body?.torrentBase64 ? decodeTorrentBase64(body.torrentBase64) : torrent!.buffer };
      const manifest = await engine.inspect(source);
      return reply.send({ data: manifest });
    } catch (error) {
      const message = (error as Error).message;
      const status = /timeout|timed out|swarm|peer/i.test(message) ? 504 : 422;
      return reply.code(status).send({ error: message, code: status === 504 ? 'SWARM_TIMEOUT' : 'INVALID_TORRENT' });
    }
  };
}
