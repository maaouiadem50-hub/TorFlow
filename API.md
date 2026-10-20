# TorFlow API

TorFlow is a live WebTorrent-to-HTTP engine. It joins a WebTorrent swarm, resolves metadata, ranks healthy indexer results, prioritizes playback pieces, and streams physical file bytes through HTTP Range.

## Configuration

Copy `.env.example` to `.env`. Set `TORFLOW_API_KEY` for protected API access; clients send it as the `x-api-key` header. `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` protect each running instance from request floods. Set `ALLOWED_ORIGINS` to a comma-separated CORS allowlist; if it is empty, browser cross-origin requests are disabled. The resolver is autonomous by default: it queries built-in public adapters without an indexer API key. `INDEXER_URL` and `INDEXER_API_KEY` are optional; when both are present, Torznab results are added to the public results. `RESOLVER_TIMEOUT_MS` is capped at 45000 milliseconds; each individual public provider remains capped at 3 seconds.

## Automated resolver

`GET /health` is a public liveness check. `GET /ready` is a public readiness check for load balancers; both return `Cache-Control: no-store`.

## Operations dashboard

Open `/admin` for the built-in operations dashboard. The page does not expose telemetry until the configured admin key is entered in the page. Protected endpoints are `GET /admin/api/overview`, `GET /admin/api/torrents`, and `GET /admin/api/streams`; they expose runtime health, memory, request counters, active torrents, active streams, peer counts, progress, configuration limits, and country distribution without returning secret values. Country distribution counts real observed API/stream requests using Vercel's country header; it is labeled as instance-scoped request data, not unique users. A persistent Redis/analytics store is required for exact cross-instance and historical totals.

`POST /v1/resolver/find-stream`

```json
{ "title": "Dune", "year": 2021, "tmdb_id": "438631" }
```

TV example:

```json
{ "title": "The Last of Us", "season": 1, "episode": 3, "imdb_id": "tt3581920" }
```

Anime and cartoon content uses these same requests: an anime film is sent as a normal movie query, and an anime/cartoon episode is sent as a normal series query. There is no separate `anime` type or endpoint.

Anime film example:

```json
{ "type": "movie", "title": "Your Name", "year": 2016, "imdb_id": "tt5311514" }
```

Anime series example:

```json
{ "type": "series", "title": "Attack on Titan", "season": 1, "episode": 1, "imdb_id": "tt2560140" }
```

Music example:

```json
{ "type": "music", "query": "Daft Punk Discovery", "artist": "Daft Punk", "album": "Discovery" }
```

For music, the built-in audio adapter searches public torrent JSON results, filters out candidates below 2 seeders, retries with a broader artist/album/track query when the detailed search has no healthy result, and prefers FLAC, ALAC, WAV, 320kbps MP3, AAC, and Opus in that order. The resolver inspects the returned torrent manifest and selects the individual `.mp3`, `.flac`, `.m4a`, `.aac`, `.wav`, `.ogg`, `.opus`, or `.alac` file rather than a cover image or unrelated file.

The service queries the built-in public adapters first, optionally queries Torznab, rejects candidates with fewer than 5 seeders, parses resolution/video/audio codec, and scores candidates using seed health plus player compatibility. It tries candidates in score order; if a public source times out or metadata/peers are unavailable, it falls back automatically.

Each resolver response includes a unique `requestId` and `diagnostics` with received/completed timestamps, duration, status, phase, attempted candidate count, selected source, cache hit, subtitle status/languages, and quality status. Recent bounded in-memory diagnostics are available to the protected dashboard through `GET /admin/api/requests`; this is runtime telemetry, not a permanent audit database.

Runtime safety limits are configurable with `MAX_CONCURRENT_TORRENTS`, `MAX_ACTIVE_STREAMS`, and `MAX_TORRENT_SIZE_BYTES`. The public indexer aggregate uses a per-source in-memory circuit breaker after repeated failures; this protects one running instance and is not a replacement for a shared Redis-backed breaker when deploying multiple workers.

Successful response:

```json
{
  "data": {
    "sourceType": "torrent",
    "streamId": "stream_abc",
    "infoHash": "...",
    "streamUrl": "/v1/torrents/.../files/0/stream",
    "fileIndex": 0,
    "quality": { "resolution": "1080p", "videoCodec": "h264", "audioCodec": "aac", "score": 74.2 },
    "audioTracks": ["movie.aac"],
    "subtitleTracks": ["movie.en.srt"],
    "candidate": { "title": "Dune.2021.1080p.x264.AAC", "seeders": 42, "score": 91.2 },
    "attempted": 1
  }
}
```

The client prefixes `streamUrl` with the API origin and passes it directly to Video.js, ExoPlayer, AVPlayer, Flutter, or React Native. The stream route supports `Range: bytes=start-end` and returns `206 Partial Content`. If a public swarm cannot return metadata or peers within the timeout, the API returns structured `504` JSON with `code: "SWARM_TIMEOUT"` instead of terminating the process.

### Subtitles

Resolver responses include a prioritized `subtitles` array. Arabic (`ara`) is selected as the default when present, followed by English, French, Spanish, and German. Torrent subtitle files with `.srt`, `.vtt`, or `.ass` extensions are served as WebVTT through `/v1/subtitles/:infoHash/:fileIndex` with `Content-Type: text/vtt; charset=utf-8` and permissive CORS.

```json
"subtitles": [
  { "lang": "ara", "label": "العربية", "isDefault": true, "url": "/v1/subtitles/<infoHash>/2", "source": "torrent", "fileIndex": 2 },
  { "lang": "eng", "label": "English", "isDefault": false, "url": "/v1/subtitles/<infoHash>/3", "source": "torrent", "fileIndex": 3 }
]
```

When `OPENSUBTITLES_API_KEY` is configured, missing Arabic or major-language tracks are queried from the OpenSubtitles REST API using IMDb/TMDB and season/episode identifiers. The server then requests a VTT download link and appends it to the response. Arabic is forced to `isDefault: true` whenever available. Without the key, the engine still serves all subtitles found inside the torrent, but cannot provide external fallback tracks.

Public providers are queried in parallel with a maximum 3-second timeout per provider. Video candidates with at least 1 seeder are eligible; music candidates require at least 2. TorFlow is strictly torrent-only: every successful response has `sourceType: "torrent"`; if no healthy torrent remains or all candidates fail, the API returns `404` with `code: "NO_HEALTHY_TORRENT"`. No third-party ad-supported embed URL is returned.

## Metadata and streaming

- `POST /v1/metadata/inspect` accepts `{ "magnet": "magnet:?..." }` and joins the swarm directly.
- `GET /v1/torrents/:infoHash` returns a registered manifest.
- `GET /v1/torrents/:infoHash/files/:fileIndex/stream` returns the media stream.
- `GET /v1/streams/:streamId/status` returns progress.
- `GET /v1/streams/:streamId/events` opens an SSE status channel.

## Deployment

- Docker: `docker build -t torflow . && docker run --rm -p 8080:8080 --env-file .env torflow`
- Render: connect the repository and use `render.yaml`.
- Railway/VPS: `npm ci --omit=dev && npm run build && npm start`.
