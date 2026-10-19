import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/server.js';

const appPromise = buildApp();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await appPromise;
    app.server.emit('request', req, res);
  } catch (error) {
    console.error('TorFlow initialization failed', error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'initialization_failed', message: error instanceof Error ? error.message : String(error) }));
  }
}
