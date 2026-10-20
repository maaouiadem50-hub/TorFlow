import { ResolverQuery } from './types.js';
import { SubtitleTrack } from './file-selector.js';
import { readTextLimited } from '../utils/http.js';

const LANGUAGE_MAP: Record<string, string> = { ar: 'ara', en: 'eng', fr: 'fra', es: 'spa', de: 'deu', it: 'ita', tr: 'tur', pt: 'por', ru: 'rus', nl: 'nld', pl: 'pol', ko: 'kor', ja: 'jpn', ara: 'ara', eng: 'eng', fra: 'fra', spa: 'spa', deu: 'deu', ita: 'ita', tur: 'tur', por: 'por', rus: 'rus', nld: 'nld', pol: 'pol', kor: 'kor', jpn: 'jpn' };
const LANGUAGE_LABELS: Record<string, string> = { ara: 'العربية', eng: 'English', fra: 'Français', spa: 'Español', deu: 'Deutsch', ita: 'Italiano', tur: 'Türkçe', por: 'Português', rus: 'Русский', nld: 'Nederlands', pol: 'Polski', kor: '한국어', jpn: '日本語' };
type OpenSubtitleFile = { file_id?: number; file_name?: string };
type OpenSubtitleItem = { attributes?: { language?: string; release?: string; files?: OpenSubtitleFile[] } };
type SearchResponse = { data?: OpenSubtitleItem[] };
type DownloadResponse = { link?: string; file_name?: string };

export interface SubtitleProvider { search(query: ResolverQuery, existing: Set<string>, requestedLanguage?: string): Promise<SubtitleTrack[]>; }

export class ConfiguredSubtitleProvider implements SubtitleProvider {
  constructor(private readonly endpoint = process.env.SUBTITLE_FALLBACK_URL, private readonly apiKey = process.env.SUBTITLE_FALLBACK_API_KEY, private readonly timeoutMs = 4000) {}
  async search(query: ResolverQuery, existing: Set<string>, requestedLanguage?: string): Promise<SubtitleTrack[]> {
    if (!this.endpoint || (!query.imdb_id && !query.tmdb_id)) return [];
    try {
      const url = new URL(this.endpoint); url.searchParams.set('imdb_id', query.imdb_id ?? ''); url.searchParams.set('tmdb_id', query.tmdb_id ?? ''); if (query.season !== undefined) url.searchParams.set('season', String(query.season)); if (query.episode !== undefined) url.searchParams.set('episode', String(query.episode)); url.searchParams.set('languages', requestedLanguage ?? 'ara,fra,eng,spa,deu,ita,tur,por,rus,nld,pol,kor,jpn');
      const headers: Record<string, string> = { accept: 'application/json' }; if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) }); if (!response.ok) return [];
      const payload = JSON.parse(await readTextLimited(response)) as { subtitles?: Array<{ lang?: string; language?: string; url?: string; label?: string }> };
      return (payload.subtitles ?? []).map((item) => { const lang = LANGUAGE_MAP[(item.lang ?? item.language ?? '').toLowerCase()] ?? ''; return lang && item.url && !existing.has(lang) ? { lang, label: item.label ?? LANGUAGE_LABELS[lang] ?? lang, isDefault: lang === 'ara' && !existing.has('ara'), url: item.url, source: 'opensubtitles' as const } : undefined; }).filter(Boolean) as SubtitleTrack[];
    } catch { return []; }
  }
}

export class OpenSubtitlesClient implements SubtitleProvider {
  private readonly fallback: SubtitleProvider;
  constructor(private readonly apiKey = process.env.OPENSUBTITLES_API_KEY, private readonly baseUrl = 'https://api.opensubtitles.com/api/v1', private readonly timeoutMs = 4000, fallback: SubtitleProvider = new ConfiguredSubtitleProvider()) { this.fallback = fallback; }
  async searchCore(query: ResolverQuery, existing: Set<string>, preferred?: string[]): Promise<SubtitleTrack[]> { const preferredLanguages = preferred?.map((language) => language.toLowerCase()).filter((language) => LANGUAGE_MAP[language]) ?? []; const languages = [...new Set(preferredLanguages.length ? preferredLanguages : ['ar', 'fr', 'en'])]; for (const language of languages) { const tracks = await this.search(query, existing, language); if (tracks.length) return tracks; } return []; }
  async search(query: ResolverQuery, existing: Set<string>, requestedLanguage?: string): Promise<SubtitleTrack[]> {
    if (!this.apiKey || query.type === 'music' || (!query.imdb_id && !query.tmdb_id)) return this.fallback.search(query, existing, requestedLanguage);
    const headers = { accept: 'application/json', 'Api-Key': this.apiKey, 'User-Agent': 'TorFlow v1.2.0' }; const url = new URL(`${this.baseUrl}/subtitles`); url.searchParams.set('languages', requestedLanguage ?? 'ar,en,fr,es,de,it,tr,pt,ru,nl,pl,ko,ja'); url.searchParams.set('order_by', 'download_count'); url.searchParams.set('order_direction', 'desc');
    if (query.type === 'series' && query.season !== undefined && query.episode !== undefined) { url.searchParams.set('season_number', String(query.season)); url.searchParams.set('episode_number', String(query.episode)); if (query.imdb_id) url.searchParams.set('parent_imdb_id', query.imdb_id.replace(/^tt/, '')); if (query.tmdb_id) url.searchParams.set('parent_tmdb_id', query.tmdb_id); } else if (query.imdb_id) url.searchParams.set('imdb_id', query.imdb_id.replace(/^tt/, '')); else if (query.tmdb_id) url.searchParams.set('tmdb_id', query.tmdb_id);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), headers }); if (!response.ok) return this.fallback.search(query, existing, requestedLanguage); const payload = JSON.parse(await readTextLimited(response)) as SearchResponse; const results: SubtitleTrack[] = []; for (const item of payload.data ?? []) { const lang = LANGUAGE_MAP[(item.attributes?.language ?? '').toLowerCase()] ?? ''; const file = item.attributes?.files?.[0]; if (!lang || (requestedLanguage && lang !== LANGUAGE_MAP[requestedLanguage]) || !file?.file_id || existing.has(lang)) continue; const link = await this.download(file.file_id, headers); if (link) results.push({ lang, label: LANGUAGE_LABELS[lang] ?? lang, isDefault: lang === 'ara' && !existing.has('ara'), url: link, source: 'opensubtitles' }); } const arabic = results.find((track) => track.lang === 'ara'); if (arabic) results.forEach((track) => { track.isDefault = track === arabic; }); return results.length ? results : this.fallback.search(query, existing, requestedLanguage); } catch { return this.fallback.search(query, existing, requestedLanguage); }
  }
  private async download(fileId: number, headers: Record<string, string>): Promise<string | undefined> { try { const response = await fetch(`${this.baseUrl}/download`, { method: 'POST', signal: AbortSignal.timeout(this.timeoutMs), headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ file_id: fileId, sub_format: 'vtt' }) }); if (!response.ok) return undefined; return (JSON.parse(await readTextLimited(response)) as DownloadResponse).link; } catch { return undefined; } }
}
