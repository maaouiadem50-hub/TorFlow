import { ResolverQuery, TorrentCandidate } from './types.js';
import { queryText } from './ranking.js';
import { readTextLimited } from '../utils/http.js';

export interface IndexerClient { search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]>; }

function tag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function attrs(xml: string, name: string): Record<string, string> {
  const match = xml.match(new RegExp(`<attr[^>]+name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i'));
  return match?.[1] ? { value: match[1] } : {};
}

export class TorznabClient implements IndexerClient {
  constructor(private readonly endpoint: string, private readonly apiKey: string, private readonly timeoutMs = 5000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('t', query.season !== undefined || query.episode !== undefined ? 'tvsearch' : 'movie');
    url.searchParams.set('q', queryText(query));
    if (query.imdb_id) url.searchParams.set('imdbid', query.imdb_id.replace(/^tt/, ''));
    if (query.tmdb_id) url.searchParams.set('tmdbid', query.tmdb_id);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, { signal: combined, headers: { accept: 'application/xml,text/xml' } });
    if (!response.ok) throw new Error(`Indexer responded with HTTP ${response.status}`);
    const xml = await readTextLimited(response);
    return [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map((match) => {
      const item = match[0];
      const seeders = Number(tag(item, 'seeders') ?? attrs(item, 'seeders').value ?? 0);
      const magnet = tag(item, 'magneturl') ?? tag(item, 'magnet') ?? tag(item, 'link') ?? '';
      return { magnet, title: tag(item, 'title') ?? 'untitled', seeders, leechers: Number(tag(item, 'leechers') ?? 0), size: Number(tag(item, 'size') ?? 0), indexer: tag(item, 'indexer') };
    }).filter((candidate) => candidate.magnet.startsWith('magnet:?'));
  }
}

export class StaticIndexerClient implements IndexerClient {
  constructor(private readonly candidates: TorrentCandidate[]) {}
  async search(): Promise<TorrentCandidate[]> { return this.candidates; }
}
