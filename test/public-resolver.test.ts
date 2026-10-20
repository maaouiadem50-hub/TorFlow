import { describe, expect, it, vi } from 'vitest';
import { MultiIndexerClient, TorrentioClient, YtsClient, seriesQueryVariants } from '../src/resolver/public-clients.js';

describe('public resolver adapters', () => {
  it('builds multiple season and episode query formats', () => {
    expect(seriesQueryVariants({ title: 'The Last of Us', season: 1, episode: 1 })).toEqual(['The Last of Us S01E01', 'The Last of Us S1 E1', 'The Last of Us Season 1 Episode 1']);
  });
  it('turns YTS torrent metadata into magnets without an API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { movies: [{ title: 'Dune', year: 2021, torrents: [{ hash: '0123456789abcdef0123456789abcdef01234567', quality: '1080p', type: 'BluRay', seeds: 42, peers: 3, size_bytes: 1000 }] }] } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const results = await new YtsClient('https://public.example/api/v2', 100).search({ title: 'Dune', year: 2021 });
    expect(results[0]?.magnet).toContain('urn:btih:0123456789abcdef0123456789abcdef01234567');
    expect(results[0]?.seeders).toBe(42);
    vi.unstubAllGlobals();
  });

  it('continues when one public adapter fails', async () => {
    const working = { search: async () => [{ magnet: 'magnet:?xt=urn:btih:ok', title: 'ok 1080p x264', seeders: 10 }] };
    const failing = { search: async () => { throw new Error('timeout'); } };
    const results = await new MultiIndexerClient([failing, working]).search({ title: 'Dune' });
    expect(results).toHaveLength(1);
  });

  it('opens a circuit after repeated source failures', async () => {
    const failingSearch = vi.fn(async () => { throw new Error('source timeout'); });
    const client = new MultiIndexerClient([{ search: failingSearch }]);
    await client.search({ title: 'Dune' });
    await client.search({ title: 'Dune' });
    await client.search({ title: 'Dune' });
    await client.search({ title: 'Dune' });
    expect(failingSearch).toHaveBeenCalledTimes(3);
  });

  it('resolves series streams using the canonical episode URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ streams: [{ name: 'Torrentio 1080p', title: 'Squid Game S01E01 1080p x264 👤 63', infoHash: '0123456789abcdef0123456789abcdef01234567' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await new TorrentioClient('https://torrentio.example', 100).search({ type: 'series', title: 'Squid Game', season: 1, episode: 1, imdb_id: 'tt10919420' });
    expect(results[0]).toMatchObject({ seeders: 63, source: 'torrentio' });
    expect(String((fetchMock.mock.calls as unknown as Array<Array<unknown>>)[0]?.[0])).toContain('/stream/series/tt10919420:1:1.json');
    vi.unstubAllGlobals();
  });

  it('tries the next series URL when Torrentio returns an empty 200 response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ streams: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ streams: [{ name: 'Torrentio', title: 'Attack on Titan S01E01 👤 150', infoHash: '0123456789abcdef0123456789abcdef01234567' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await new TorrentioClient('https://torrentio.example', 100).search({ type: 'series', title: 'Attack on Titan', season: 1, episode: 1, imdb_id: 'tt2560140' });
    expect(results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
