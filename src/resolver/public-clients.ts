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
const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9'
};

function debug(event: string, data: Record<string, unknown>): void {
  if (resolverDebug) console.log(JSON.stringify({ scope: 'resolver', event, ...data }));
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function magnet(hash: string, name: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(hash)) return '';
  const params = [`xt=urn:btih:${hash}`, `dn=${encodeURIComponent(name)}`];
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
      `${base} S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`,
      `${base} S${s} E${e}`,
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

/** Enhanced HTML/magnet extractor: magnets, btih hashes, data attributes */
function parseHtmlResults(html: string, source: string, fallback: string): TorrentCandidate[] {
  const results: TorrentCandidate[] = [];
  const seen = new Set<string>();

  const push = (hash: string, title: string, seeders = 0) => {
    const h = hash.toLowerCase();
    if (seen.has(h)) return;
    const m = magnet(hash, title || fallback);
    if (!m) return;
    seen.add(h);
    results.push({ magnet: m, title: title || fallback, seeders, source });
  };

  // 1) Full magnet URIs
  const magnetPattern = /magnet:\?[^"'<>\s]+/gi;
  for (const raw of html.match(magnetPattern) ?? []) {
    const match = raw.match(/xt=urn%3Abtih%3A([^&]+)|xt=urn:btih:([^&]+)/i);
    const hash = match?.[1] ?? match?.[2];
    if (!hash) continue;
    const title = decodeURIComponent(raw.match(/[?&]dn=([^&]+)/i)?.[1] ?? fallback).replace(/[+]/g, ' ');
    const context = html.slice(Math.max(0, html.indexOf(raw) - 200), html.indexOf(raw) + raw.length + 200);
    const seeders = Number(context.match(/(?:seed(?:s|ers)?|👤)[^0-9]{0,12}(\d+)/i)?.[1] ?? 0);
    push(hash, title, seeders);
    if (results.length >= 500) break;
  }

  // 2) Info-hashes in common patterns (href, data-hash, btih=, itorrents, .torrent links)
  if (results.length < 30) {
    const hashPatterns = [
      /btih[:/=]([a-fA-F0-9]{40})/g,
      /data-(?:hash|infohash)=["']([a-fA-F0-9]{40})["']/gi,
      /\/torrent\/([a-fA-F0-9]{40})/gi,
      /info_hash=([a-fA-F0-9]{40})/gi,
      /([a-fA-F0-9]{40})\.torrent/g
    ];
    for (const pattern of hashPatterns) {
      for (const m of html.matchAll(pattern)) {
        const hash = m[1];
        if (!hash) continue;
        const start = Math.max(0, (m.index ?? 0) - 120);
        const context = html.slice(start, start + 300);
        const titleMatch = context.match(/title=["']([^"']{5,120})["']/) ?? context.match(/>([^<]{8,100})</);
        const title = (titleMatch?.[1] ?? fallback).replace(/\s+/g, ' ').trim();
        const seeders = Number(context.match(/(?:seed(?:s|ers)?)[^0-9]{0,12}(\d+)/i)?.[1] ?? 0);
        push(hash, title, seeders);
        if (results.length >= 100) break;
      }
    }
  }

  return results;
}

function xmlTag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
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
    const suffix = kind === 'series' ? `:${query.season ?? 1}:${query.episode ?? 1}` : '';
    const url = `${this.baseUrl}/stream/${kind}/${id}${suffix}.json`;
    let response: Response | undefined;
    let responseBody = '';
    let lastError: unknown;
    const urls = [url];
    if (kind === 'series' && query.season !== undefined && query.episode !== undefined) {
      const padded = `${this.baseUrl}/stream/series/${id}:${String(query.season).padStart(2, '0')}:${String(query.episode).padStart(2, '0')}.json`;
      urls.push(padded);
      if (query.title || query.query) {
        const titleId = encodeURIComponent(query.title ?? query.query ?? '');
        urls.push(`${this.baseUrl}/stream/series/${titleId}:${query.season}:${query.episode}.json`);
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
          headers: { ...DEFAULT_HEADERS, accept: 'text/html,application/xhtml+xml' }
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
    super((_q, text) => `https://www.1377x.to/search/${encodeURIComponent(text)}/1/`, '1337x', timeoutMs);
  }
}

export class EztvClient implements IndexerClient {
  constructor(private readonly timeoutMs = 4000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (query.type === 'music') return [];
    // Prefer official API when imdb_id is available
    if (query.imdb_id) {
      const imdb = query.imdb_id.replace(/^tt/i, '');
      try {
        const url = `https://eztv.re/api/get-torrents?limit=50&imdb_id=${encodeURIComponent(imdb)}`;
        const response = await fetch(url, {
          signal: timeoutSignal(this.timeoutMs, signal),
          headers: { accept: 'application/json', ...DEFAULT_HEADERS }
        });
        if (response.ok) {
          const payload = JSON.parse(await readTextLimited(response)) as {
            torrents?: Array<{
              hash?: string;
              title?: string;
              filename?: string;
              seeds?: number;
              peers?: number;
              size_bytes?: number;
              magnet_url?: string;
            }>;
          };
          const fromApi = (payload.torrents ?? [])
            .map((t) => {
              const title = t.title ?? t.filename ?? queryText(query);
              const m = t.magnet_url
                ? normalizeMagnet(t.magnet_url, title)
                : t.hash
                  ? magnet(t.hash, title)
                  : '';
              return {
                magnet: m,
                title,
                seeders: Number(t.seeds ?? 0),
                leechers: Number(t.peers ?? 0),
                size: Number(t.size_bytes ?? 0),
                source: 'eztv'
              };
            })
            .filter((c) => c.magnet);
          if (fromApi.length) return fromApi;
        }
      } catch {
        /* fall through to HTML */
      }
    }
    const text = queryText(query);
    const response = await fetch(`https://eztv.re/search/${encodeURIComponent(text)}`, {
      signal: timeoutSignal(this.timeoutMs, signal),
      headers: { ...DEFAULT_HEADERS }
    });
    if (!response.ok) throw new Error(`eztv HTTP ${response.status}`);
    return parseHtmlResults(await readTextLimited(response), 'eztv', text);
  }
}

export class TorrentGalaxyClient extends HtmlTorrentClient {
  constructor(timeoutMs = 3000) {
    super((_q, text) => `https://torrentgalaxy.one/torrents.php?search=${encodeURIComponent(text)}`, 'torrentgalaxy', timeoutMs);
  }
}

/** NYAA via RSS — magnets/infohashes appear reliably in the feed */
export class NyaaClient implements IndexerClient {
  constructor(private readonly timeoutMs = 4000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (query.type === 'music') return [];
    const variants =
      query.type === 'tv_program' || isTvProgram(query) ? tvProgramQueryVariants(query) : seriesQueryVariants(query);
    const all: TorrentCandidate[] = [];
    for (const text of variants) {
      const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(text)}&c=0_0&f=0`;
      try {
        const response = await fetch(url, {
          signal: timeoutSignal(this.timeoutMs, signal),
          headers: { accept: 'application/rss+xml,application/xml,text/xml', ...DEFAULT_HEADERS }
        });
        if (!response.ok) continue;
        const xml = await readTextLimited(response);
        for (const itemMatch of xml.matchAll(/<item[\s\S]*?<\/item>/gi)) {
          const item = itemMatch[0];
          const title = xmlTag(item, 'title') ?? text;
          const seeders = Number(xmlTag(item, 'nyaa:seeders') ?? xmlTag(item, 'seeders') ?? 0);
          const size = Number(xmlTag(item, 'nyaa:size') ?? 0);
          let m =
            xmlTag(item, 'nyaa:infoHash') ? magnet(xmlTag(item, 'nyaa:infoHash')!, title) : '';
          if (!m) {
            const link = xmlTag(item, 'link') ?? '';
            if (link.startsWith('magnet:?')) m = normalizeMagnet(link, title);
            else {
              const hashMatch = item.match(/btih:([a-f0-9]{40})/i) ?? item.match(/([a-f0-9]{40})/);
              if (hashMatch?.[1] && hashMatch[1].length === 40) m = magnet(hashMatch[1], title);
            }
          }
          // Also try enclosure / description magnets
          if (!m) {
            const desc = xmlTag(item, 'description') ?? '';
            const mm = desc.match(/magnet:\?[^"'<\s]+/i);
            if (mm) m = normalizeMagnet(mm[0], title);
          }
          if (m) all.push({ magnet: m, title, seeders, size: Number.isFinite(size) ? size : 0, source: 'nyaa' });
        }
        if (all.some((c) => c.seeders >= 3)) break;
      } catch {
        /* try next variant */
      }
    }
    return all;
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

/** Internet Archive via official JSON advanced search + torrent files */
export class InternetArchiveClient implements IndexerClient {
  constructor(private readonly timeoutMs = 5000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    if (query.type === 'music') return [];
    const text = queryText(query);
    const q = `(${text}) AND format:("Torrent")`;
    const url =
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
      `&fl[]=identifier&fl[]=title&fl[]=downloads&rows=15&page=1&output=json`;
    try {
      const response = await fetch(url, {
        signal: timeoutSignal(this.timeoutMs, signal),
        headers: { accept: 'application/json', ...DEFAULT_HEADERS }
      });
      if (!response.ok) return [];
      const payload = JSON.parse(await readTextLimited(response)) as {
        response?: { docs?: Array<{ identifier?: string; title?: string; downloads?: number }> };
      };
      const docs = payload.response?.docs ?? [];
      const results: TorrentCandidate[] = [];
      for (const doc of docs.slice(0, 10)) {
        if (!doc.identifier) continue;
        // Fetch item metadata for torrent hash when possible
        try {
          const metaUrl = `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`;
          const metaRes = await fetch(metaUrl, {
            signal: timeoutSignal(this.timeoutMs, signal),
            headers: { accept: 'application/json', ...DEFAULT_HEADERS }
          });
          if (!metaRes.ok) continue;
          const meta = JSON.parse(await readTextLimited(metaRes)) as {
            files?: Array<{ name?: string; btih?: string; format?: string; size?: string }>;
            metadata?: { title?: string };
          };
          const title = doc.title ?? meta.metadata?.title ?? text;
          for (const file of meta.files ?? []) {
            if (file.btih) {
              results.push({
                magnet: magnet(file.btih, title),
                title: `${title} (${file.name ?? 'torrent'})`,
                seeders: Math.min(50, Number(doc.downloads ?? 1) || 1),
                size: Number(file.size ?? 0),
                source: 'internet-archive'
              });
            } else if (file.format?.toLowerCase().includes('torrent') || file.name?.endsWith('.torrent')) {
              // No btih in metadata — still note via generic page parse fallback later
            }
          }
        } catch {
          /* skip item */
        }
        if (results.length >= 20) break;
      }
      return results.filter((c) => c.magnet);
    } catch {
      return [];
    }
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

/** Academic Torrents — parse search HTML + common hash patterns */
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
  constructor(private readonly timeoutMs = 5000) {}
  async search(query: ResolverQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    const text = (query.title ?? query.query ?? '').toLowerCase();
    const isDistro = this.keywords.some((k) => text.includes(k)) || /\b(iso|linux)\b/i.test(text);
    if (!isDistro) return [];
    const searchText = `${queryText(query)} iso`;
    // Prefer Internet Archive + Apibay for ISOs (structured)
    const clients: IndexerClient[] = [
      new InternetArchiveClient(this.timeoutMs),
      new HtmlTorrentClient(
        (_q, t) => `https://www.limetorrents.lol/search/all/${encodeURIComponent(t)}/`,
        'linux-limetorrents',
        this.timeoutMs
      ),
      new NyaaClient(this.timeoutMs)
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
        const response = await fetch(`${this.baseUrl}/q.php?q=${encodeURIComponent(term)}&cat=200`, {
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
      const response = await fetch(`${this.baseUrl}/q.php?q=${encodeURIComponent(text)}`, {
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
