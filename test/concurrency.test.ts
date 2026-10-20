import { describe, expect, it } from 'vitest';
import { TorrentEngine } from '../src/engine/torrent-engine.js';

describe('Concurrency and Reference-Aware Piece Selection', () => {
  it('independent users on same torrent (User A Ep1 & User B Ep5) do not conflict or deselect each other', async () => {
    const selectedRanges: Array<{ start: number; end: number; priority?: number }> = [];
    const deselectedRanges: Array<{ start: number; end: number }> = [];

    const mockTorrent: any = {
      infoHash: '5566778899001122334455667788990011223344',
      name: 'SeasonPack',
      pieceLength: 100,
      pieces: new Array(10).fill('piece'),
      files: [
        { name: 'S01E01.mp4', path: 'S01E01.mp4', length: 200, offset: 0, createReadStream: () => null },
        { name: 'S01E05.mp4', path: 'S01E05.mp4', length: 200, offset: 400, createReadStream: () => null }
      ],
      downloaded: 0,
      uploaded: 0,
      numPeers: 10,
      progress: 0,
      select: (start: number, end: number, priority?: number) => {
        selectedRanges.push({ start, end, priority });
      },
      deselect: (start: number, end: number) => {
        deselectedRanges.push({ start, end });
      },
      destroy: (cb: any) => cb && cb()
    };

    const mockClient: any = {
      add: (src: any, cb: any) => { cb && cb(mockTorrent); return mockTorrent; },
      destroy: (cb: any) => cb && cb()
    };

    const engine = new TorrentEngine(mockClient, { idleTorrentGracePeriodMs: 5000 });
    const manifest = await engine.registerManifest({ magnet: `magnet:?xt=urn:btih:${mockTorrent.infoHash}` });

    // User A streams Episode 1 (pieces 0, 1)
    const streamUserA = await engine.openStream(manifest.infoHash, 0);
    expect(engine.getActiveStreamsCount(manifest.infoHash)).toBe(1);
    const selectsAfterA = [...selectedRanges];

    // User B streams Episode 5 (pieces 4, 5)
    const streamUserB = await engine.openStream(manifest.infoHash, 1);
    expect(engine.getActiveStreamsCount(manifest.infoHash)).toBe(2);

    // Verify User B's stream DID NOT deselect User A's pieces!
    expect(deselectedRanges.length).toBe(0);

    // User A finishes and disconnects
    await streamUserA.destroy();
    expect(engine.getActiveStreamsCount(manifest.infoHash)).toBe(1);

    // Episode 5 pieces must still be active; User B is not broken
    expect(engine.getActiveStreamsCount(manifest.infoHash)).toBe(1);

    // User B finishes
    await streamUserB.destroy();
    expect(engine.getActiveStreamsCount(manifest.infoHash)).toBe(0);

    await engine.destroy();
  });

  it('handles concurrency stress with 1, 5, 10, 20 concurrent streams and returns resources cleanly', async () => {
    const engine = new TorrentEngine(undefined, { maxConcurrentTorrents: 10, idleTorrentGracePeriodMs: 100 });
    const hash = '6677889900112233445566778899001122334455';
    engine.registerParsedManifest({
      infoHash: hash,
      name: 'big-video.mp4',
      pieceLength: 262144,
      pieceCount: 10,
      totalSize: 1000000,
      files: [{ index: 0, path: 'big-video.mp4', name: 'big-video.mp4', size: 1000000, mimeType: 'video/mp4', offset: 0, selected: false }]
    });

    for (const count of [1, 5, 10, 20]) {
      const handles = await Promise.all(
        Array.from({ length: count }, () => engine.openStream(hash, 0))
      );
      expect(engine.getActiveStreamsCount(hash)).toBe(count);

      // Simulate partial reading / seeking
      await Promise.all(
        handles.map(async (h, idx) => {
          const stream = h.createReadStream({ start: idx * 100, end: idx * 100 + 50 });
          const chunks: any[] = [];
          for await (const chunk of stream as any) {
            chunks.push(chunk);
          }
          expect(chunks.length).toBeGreaterThan(0);
        })
      );

      // Clean up all streams
      await Promise.all(handles.map((h) => h.destroy()));
      expect(engine.getActiveStreamsCount(hash)).toBe(0);
    }

    // Wait for idle grace period
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(engine.getActiveTorrentsCount()).toBe(0);

    await engine.destroy();
  });

  it('rejects streams above the configured active-stream limit', async () => {
    const engine = new TorrentEngine(undefined, { maxActiveStreams: 2, idleTorrentGracePeriodMs: 0 });
    const hash = '7788990011223344556677889900112233445566';
    engine.registerParsedManifest({ infoHash: hash, name: 'limited.mp4', pieceLength: 262144, pieceCount: 1, totalSize: 1024, files: [{ index: 0, path: 'limited.mp4', name: 'limited.mp4', size: 1024, mimeType: 'video/mp4', offset: 0, selected: false }] });
    const first = await engine.openStream(hash, 0);
    const second = await engine.openStream(hash, 0);
    await expect(engine.openStream(hash, 0)).rejects.toThrow('Maximum active streams limit reached');
    await first.destroy();
    await second.destroy();
    await engine.destroy();
  });

  it('rejects parsed manifests above the configured torrent-size limit', () => {
    const engine = new TorrentEngine(undefined, { maxTorrentBytes: 1_048_576 });
    expect(() => engine.registerParsedManifest({ infoHash: '8899001122334455667788990011223344556677', name: 'too-large.mp4', pieceLength: 262144, pieceCount: 1, totalSize: 1_048_577, files: [{ index: 0, path: 'too-large.mp4', name: 'too-large.mp4', size: 1_048_577, mimeType: 'video/mp4', offset: 0, selected: false }] })).toThrow('Torrent exceeds maximum configured size');
    expect(engine.getManifest('8899001122334455667788990011223344556677')).toBeUndefined();
  });
});
