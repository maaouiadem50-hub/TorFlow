import { IndexerClient } from './torznab-client.js';
import { ResolverQuery, TorrentCandidate } from './types.js';
import { queryText, cleanQueryTerm } from './ranking.js';
import { isTvProgram, tvProgramQueryVariants } from './tv-program.js';
import { readTextLimited } from '../utils/http.js';

const TRACKERS = [
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce'
];
const resolverDebug = process.env.RESOLVER_DEBUG === 'true';

function debug(event: string, data: Record<string, unknown>): void {
  if (resolverDebug) console.log(JSON.stringify({ scope: 'resolver', event, ...data }));
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function magnet(hash: string, name: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(hash)) return '';
  const params = [`xt=urn:btih:\( {hash}`, `dn= \){encodeURIComponent(name)}`];
  for (const tracker of TRACKERS) params.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${params.join('&')}`;
}

function normalizeMagnet(value: string, name: string): string {
  const decoded = decodeURIComponent(value);
  const match = decoded.match(/[?&]xt=urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i);
  return match?.[1] ? magnet(match[1], name) : '';
}

function isVideo(query: ResolverQuery): boolean {
  return query.type !== 'music';
}

export function seriesQueryVariants(query: ResolverQuery): string[] {
  const base = cleanQueryTerm(query.title ?? query.query ?? '') || (query.title ?? query.query ?? '');
  if (query.season === undefined || query.episode === undefined) return [queryText(query)];
  const s = query.season;
  const e = query.episode;
  return [
    ...new Set([
      `\( {base} S \){String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`,
      `\( {base} S \){s} E${e}`,
      `${base} Season ${s} Episode ${e}`
    ])
  ];
}

export function parseTorrentioSeeders(name?: string, title?: string, description?: string): number {
  const text = [name, title, description].filter((value): value is string => Boolean(value)).join('\n');
  const matches = [...text.matchAll(/(?:👤|seed(?:s|ers)?\s*[:=]?)[^0-9]{0,12}(\d+)|\b(\d+)\s*seed(?:s|ers)?\b/gi)]
    .map((match) => Number(match[1] ?? match[2]))
    .filter(Number.isFinite);
  return matches.length ? Math.max(...matches) : 0;
}

function parseHtmlResults(html: string, source: string, fallback: string): TorrentCandidate[] {
  const results: TorrentCandidate[] = [];
  const seen = new Set<string>();
  const magnetPattern = /magnet:\?[^"'<>\s]+/gi;
  for (const raw of html.match(magnetPattern) ?? []) {
    const match = raw.match(/xt=urn%3Abtih%3A([^&]+)|xt=urn:btih:([^&]+)/i);
    const hash = match?.[1] ?? match?.[2];
    if (!hash || seen.has(hash.toLowerCase())) continue;
    seen.add(hash.toLowerCase());
    const title = decodeURIComponent(raw.match(/[?&]dn=([^&]+)/i)?.[1] ?? fallback).replace(/[+]/g, ' ');
    const context = html.slice(Math.max(0, html.indexOf(raw) - 180), html.indexOf(raw) + raw.length + 180);
    const seeders = Number(context.match(/(?:seed(?:s|ers)?|👤)[^0-9]{0,12}(\d+)/i)?.[1] ?? 0);
    const normalized = normalizeMagnet(raw, title);
    if (normalized) results.push({ magnet: normalized, title, seeders, source });
    if (results.length >= 500) break;
  }
  return results;
}

export class YtsClient implements IndexerClient {
  constructor(private readonly baseUrl = 'https://movies-api.accel.li/api/v2', private readonly timeoutMs = 3000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (query.type === 'music' || query.season !== undefined || query.episode !== undefined) return [];
    const url = new URL(`${this.baseUrl}/list_movies.json`);
    url.searchParams.set('query_term', query.imdb_id ?? query.title ?? query.query ?? '');
    url.searchParams.set('limit', '20');
    if (query.year) url.searchParams.set('year', String(query.year));
    const response = await fetch(url, { signal: timeoutSignal(this.timeoutMs, signal), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`YTS HTTP ${response.status}`);
    const payload = JSON.parse(await readTextLimited(response)) as {
      data?: {
        movies?: Array<{
          title?: string;
          year?: number;
          torrents?: Array<{
            hash?: string;
            quality?: string;
            type?: string;
            seeds?: number;
            peers?: number;
            size_bytes?: number;
          }>;
        }>;
      };
    };
    return (payload.data?.movies ?? []).flatMap((movie) =>
      (movie.torrents ?? []).map((torrent) => {
        const title = `${movie.title ?? query.title ?? query.query ?? ''} ${movie.year ?? query.year ?? ''} ${torrent.quality ?? ''} ${torrent.type ?? ''} x264`;
        return {
          magnet: torrent.hash ? magnet(torrent.hash, title) : '',
          title,
          seeders: Number(torrent.seeds ?? torrent.peers ?? 0),
          leechers: Number(torrent.peers ?? 0),
          size: Number(torrent.size_bytes ?? 0),
          source: 'yts'
        };
      })
    ).filter((candidate) => candidate.magnet);
  }
}

export class TorrentioClient implements IndexerClient {
  constructor(private readonly baseUrl = 'https://torrentio.strem.fun', private readonly timeoutMs = 3000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (query.type === 'music') return [];
    const kind =
      query.season !== undefined || query.episode !== undefined || query.type === 'series' || query.type === 'tv_program'
        ? 'series'
        : 'movie';
    const id = query.imdb_id ?? (query.tmdb_id ? `tmdb:${query.tmdb_id}` : encodeURIComponent(query.title ?? query.query ?? ''));
    const suffix = kind === 'series' ? `:\( {query.season ?? 1}: \){query.episode ?? 1}` : '';
    const url = `\( {this.baseUrl}/stream/ \){kind}/\( {id} \){suffix}.json`;
    let response: Response | undefined;
    let responseBody = '';
    let lastError: unknown;
    const urls = [url];
    if (kind === 'series' && query.season !== undefined && query.episode !== undefined) {
      const padded = `\( {this.baseUrl}/stream/series/ \){id}:\( {String(query.season).padStart(2, '0')}: \){String(query.episode).padStart(2, '0')}.json`;
      urls.push(padded);
      if (query.title || query.query) {
        const titleId = encodeURIComponent(query.title ?? query.query ?? '');
        urls.push(`\( {this.baseUrl}/stream/series/ \){titleId}:\( {query.season}: \){query.episode}.json`);
      }
    }
    for (const requestUrl of urls) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        debug('torrentio_request_start', {
          url: requestUrl,
          attempt: attempt + 1,
          type: query.type ?? 'movie',
          imdbId: query.imdb_id,
          season: query.season,
          episode: query.episode
        });
        try {
          response = await fetch(requestUrl, {
            signal: timeoutSignal(Math.max(this.timeoutMs, 8000), signal),
            headers: { accept: 'application/json' }
          });
          responseBody = await readTextLimited(response);
          debug('torrentio_response', {
            url: requestUrl,
            attempt: attempt + 1,
            status: response.status,
            bytes: responseBody.length,
            preview: responseBody.slice(0, 180)
          });
          if (response.ok) {
            try {
              const parsed = JSON.parse(responseBody) as { streams?: unknown[] };
              if ((parsed.streams ?? []).length > 0) break;
            } catch {
              /* continue */
            }
            response = undefined;
            continue;
          }
          lastError = new Error(`Torrentio HTTP ${response.status}`);
          response = undefined;
          continue;
        } catch (error) {
          lastError = error;
          debug('torrentio_request_error', { url: requestUrl, attempt: attempt + 1, error: String(error) });
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (response?.ok) break;
    }
    if (!response?.ok) throw lastError instanceof Error ? lastError : new Error('Torrentio request failed');
    const payload = JSON.parse(responseBody) as {
      streams?: Array<{ name?: string; title?: string; description?: string; url?: string; infoHash?: string }>;
    };
    const candidates = (payload.streams ?? [])
      .map((stream) => {
        const title = [stream.name, stream.title, stream.description].filter(Boolean).join('\n') || 'Torrentio result';
        const hash = stream.infoHash ?? stream.url?.match(/urn:btih:([^&/]+)/i)?.[1];
        const candidateMagnet = hash
          ? magnet(hash, title)
          : stream.url?.startsWith('magnet:?')
            ? normalizeMagnet(stream.url, title)
            : '';
        const parsedSeeders = parseTorrentioSeeders(stream.name, stream.title, stream.description);
        return {
          magnet: candidateMagnet,
          title,
          seeders: parsedSeeders > 0 ? parsedSeeders : 1,
          source: 'torrentio'
        };
      })
      .filter((candidate) => candidate.magnet);
    debug('torrentio_candidates', {
      count: candidates.length,
      seeders: candidates.slice(0, 10).map((candidate) => candidate.seeders)
    });
    return candidates;
  }
}

class HtmlTorrentClient implements IndexerClient {
  constructor(
    private readonly url: (query: ResolverQuery, text: string) => string,
    private readonly source: string,
    private readonly timeoutMs = 3000
  ) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (!isVideo(query)) return [];
    const variants =
      query.type === 'tv_program' || isTvProgram(query) ? tvProgramQueryVariants(query) : seriesQueryVariants(query);
    const settled = await Promise.allSettled(
      variants.map(async (text) => {
        const response = await fetch(this.url(query, text), {
          signal: timeoutSignal(this.timeoutMs, signal),
          headers: { accept: 'text/html,application/xhtml+xml' }
        });
        if (!response.ok) throw new Error(`${this.source} HTTP ${response.status}`);
        return parseHtmlResults(await readTextLimited(response), this.source, text);
      })
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }
}

export class X1337Client extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://1337x.to/search/${encodeURIComponent(text)}/1/`, '1337x', timeoutMs);
  }
}

export class EztvClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://eztv.re/search/${encodeURIComponent(text)}`, 'eztv', timeoutMs);
  }
}

export class TorrentGalaxyClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(text)}`, 'torrentgalaxy', timeoutMs);
  }
}

export class NyaaClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(text)}`, 'nyaa', timeoutMs);
  }
}

export class LimeTorrentsClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://www.limetorrents.lol/search/all/${encodeURIComponent(text)}/`, 'limetorrents', timeoutMs);
  }
}

export class TorlockClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://www.torlock.com/all/torrents/${encodeURIComponent(text)}.html`, 'torlock', timeoutMs);
  }
}

export class Torrentz2Client extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://torrentz2.nz/search?f=${encodeURIComponent(text)}`, 'torrentz2', timeoutMs);
  }
}

export class RuTrackerClient extends HtmlTorrentClient {
  constructor(timeoutMs = 4000) {
    super((_q, text) => `https://rutracker.org/forum/tracker.php?nm=${encodeURIComponent(text)}`, 'rutracker', timeoutMs);
  }
}

export class YggTorrentClient extends HtmlTorrentClient {
  constructor(timeoutMs = 4000) {
    super(
      (_q, text) => `https://www.yggtorrent.top/engine/search?name=${encodeURIComponent(text)}&do=search`,
      'yggtorrent',
      timeoutMs
    );
  }
}

export class InternetArchiveClient extends HtmlTorrentClient {
  constructor(timeoutMs = 4000) {
    super(
      (_q, text) => `https://archive.org/search?query=${encodeURIComponent(text)}&and[]=format%3A%22Torrent%22`,
      'internet-archive',
      timeoutMs
    );
  }
}

export class TorrentDownloadsClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://www.torrentdownloads.pro/search/?search=${encodeURIComponent(text)}`, 'torrentdownloads', timeoutMs);
  }
}

export class PsAripsClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://psarips.top/?s=${encodeURIComponent(text)}`, 'psarips', timeoutMs);
  }
}

export class ExtToClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://ext.to/search/?q=${encodeURIComponent(text)}`, 'ext.to', timeoutMs);
  }
}

export class RarbgMirrorClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://rarbg.to/torrents.php?search=${encodeURIComponent(text)}`, 'rarbg-mirror', timeoutMs);
  }
}

export class KickassMirrorClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://kickasstorrents.to/usearch/${encodeURIComponent(text)}/`, 'kickass-mirror', timeoutMs);
  }
}

export class FitGirlClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://fitgirl-repacks.site/?s=${encodeURIComponent(text)}`, 'fitgirl', timeoutMs);
  }
}

export class AcademicTorrentsClient extends HtmlTorrentClient {
  constructor(timeoutMs = 4000) {
    super((_q, text) => `https://academictorrents.com/browse.php?search=${encodeURIComponent(text)}`, 'academic-torrents', timeoutMs);
  }
}

export class LinuxDistroClient implements IndexerClient {
  private readonly keywords = [
    'ubuntu', 'debian', 'fedora', 'arch linux', 'archlinux',
    'linux mint', 'linuxmint', 'rocky linux', 'rockylinux',
    'almalinux', 'opensuse', 'open suse'
  ];
  constructor(private readonly timeoutMs = 4000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    const text = (query.title ?? query.query ?? '').toLowerCase();
    const isDistro = this.keywords.some((k) => text.includes(k)) || /\b(iso|linux)\b/i.test(text);
    if (!isDistro) return [];
    const searchText = `${queryText(query)} iso`;
    const clients = [
      new HtmlTorrentClient(
        (_q, t) => `https://www.limetorrents.lol/search/all/${encodeURIComponent(t)}/`,
        'linux-limetorrents',
        this.timeoutMs
      ),
      new HtmlTorrentClient((_q, t) => `https://1337x.to/search/${encodeURIComponent(t)}/1/`, 'linux-1337x', this.timeoutMs),
      new HtmlTorrentClient(
        (_q, t) => `https://archive.org/search?query=${encodeURIComponent(t)}+format%3ATorrent`,
        'linux-archive',
        this.timeoutMs
      )
    ];
    const settled = await Promise.allSettled(
      clients.map((c) => c.search({ ...query, query: searchText, title: searchText }, signal))
    );
    return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }
}

export class ApibayVideoClient implements IndexerClient {
  constructor(private readonly baseUrl = 'https://apibay.org', private readonly timeoutMs = 3000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (query.type === 'music') return [];
    const textVariants =
      query.type === 'tv_program' || isTvProgram(query) ? tvProgramQueryVariants(query) : seriesQueryVariants(query);
    const primary = queryText(query);
    const searchTerms = [...new Set([primary, ...textVariants])];
    const search = async (term: string): Promise<TorrentCandidate[]> => {
      try {
        const response = await fetch(`\( {this.baseUrl}/q.php?q= \){encodeURIComponent(term)}&cat=200`, {
          signal: timeoutSignal(this.timeoutMs, signal),
          headers: { accept: 'application/json' }
        });
        if (!response.ok) return [];
        const payload = (await response.json()) as Array<{
          name?: string;
          info_hash?: string;
          seeders?: number;
          leechers?: number;
          size?: string;
        }>;
        if (!Array.isArray(payload)) return [];
        return payload
          .filter((item) => item.name && item.name !== 'No results returned' && item.info_hash)
          .map((item) => ({
            magnet: magnet(item.info_hash!, item.name!),
            title: item.name!,
            seeders: Number(item.seeders ?? 0),
            leechers: Number(item.leechers ?? 0),
            size: Number(item.size ?? 0),
            source: 'apibay'
          }))
          .filter((c) => c.magnet);
      } catch {
        return [];
      }
    };
    const all: TorrentCandidate[] = [];
    for (const term of searchTerms) {
      const candidates = await search(term);
      all.push(...candidates);
      if (all.some((c) => c.seeders >= 5)) break;
    }
    return all;
  }
}

export class AudioPublicClient implements IndexerClient {
  constructor(private readonly baseUrl = 'https://apibay.org', private readonly timeoutMs = 3000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (query.type !== 'music') return [];
    const detailed = queryText(query);
    const terms = [
      ...new Set(
        [
          detailed,
          [query.artist, query.album, query.track, query.query].filter(Boolean).join(' '),
          query.track,
          query.album,
          query.artist
        ].filter((value): value is string => Boolean(value))
      )
    ];
    const search = async (text: string): Promise<TorrentCandidate[]> => {
      const response = await fetch(`\( {this.baseUrl}/q.php?q= \){encodeURIComponent(text)}`, {
        signal: timeoutSignal(this.timeoutMs, signal),
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`Audio indexer HTTP ${response.status}`);
      const payload = JSON.parse(await readTextLimited(response)) as Array<{
        name?: string;
        info_hash?: string;
        seeders?: number;
        leechers?: number;
        size?: string;
      }>;
      return payload
        .map((item) => {
          const title = item.name ?? text;
          return {
            magnet: item.info_hash ? magnet(item.info_hash, title) : '',
            title,
            seeders: Number(item.seeders ?? 0),
            leechers: Number(item.leechers ?? 0),
            size: Number(item.size ?? 0),
            source: 'public-audio'
          };
        })
        .filter((candidate) => candidate.magnet);
    };
    const all: TorrentCandidate[] = [];
    for (const term of terms) {
      const found = await search(term);
      all.push(...found);
      if (found.some((candidate) => candidate.seeders >= 2)) break;
    }
    return all;
  }
}

export class MultiIndexerClient implements IndexerClient {
  constructor(private readonly clients: IndexerClient[]) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    const settled = await Promise.allSettled(this.clients.map((client) => client.search(query, signal)));
    const results = settled.flatMap((result, index) => {
      if (result.status === 'fulfilled') {
        debug('indexer_result', {
          index,
          count: result.value.length,
          seeders: result.value.slice(0, 5).map((candidate) => candidate.seeders)
        });
        return result.value;
      }
      debug('indexer_error', { index, error: String(result.reason) });
      return [];
    });
    debug('indexer_aggregate', { count: results.length });
    return results;
  }
}

export function createPublicIndexer(timeoutMs = 3000): IndexerClient {
  return new MultiIndexerClient([
    new YtsClient(undefined, timeoutMs),
    new TorrentioClient(undefined, timeoutMs),
    new ApibayVideoClient(undefined, timeoutMs),
    new X1337Client(timeoutMs),
    new EztvClient(timeoutMs),
    new TorrentGalaxyClient(timeoutMs),
    new AudioPublicClient(undefined, timeoutMs),
    new NyaaClient(timeoutMs),
    new LimeTorrentsClient(timeoutMs),
    new TorlockClient(timeoutMs),
    new Torrentz2Client(timeoutMs),
    new RuTrackerClient(timeoutMs),
    new YggTorrentClient(timeoutMs),
    new InternetArchiveClient(timeoutMs),
    new TorrentDownloadsClient(timeoutMs),
    new PsAripsClient(timeoutMs),
    new ExtToClient(timeoutMs),
    new RarbgMirrorClient(timeoutMs),
    new KickassMirrorClient(timeoutMs),
    new FitGirlClient(timeoutMs),
    new AcademicTorrentsClient(timeoutMs),
    new LinuxDistroClient(timeoutMs)
  ]);
}

export function buildPublicQuery(query: ResolverQuery): string {
  return queryText(query);
}
