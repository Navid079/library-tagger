import { app } from "electron";
import type { ProviderCandidate, TrackDetails } from "../shared/models";
import { CatalogDatabase } from "./database";
import { corePath, run } from "./privilege";

type MbRecording = {
  id: string; title: string; score?: number; length?: number;
  "artist-credit"?: Array<{ name: string; artist?: { name: string } }>;
  releases?: Array<{ id: string; title: string; date?: string; "artist-credit"?: Array<{ name: string }> }>;
  isrcs?: string[];
};

class RateGate {
  private nextAt = 0;
  constructor(private readonly intervalMs: number) {}
  async wait(signal?: AbortSignal): Promise<void> {
    const delay = Math.max(0, this.nextAt - Date.now());
    this.nextAt = Math.max(this.nextAt, Date.now()) + this.intervalMs;
    if (delay) await abortableDelay(delay, signal);
    signal?.throwIfAborted();
  }
}

export class ProviderService {
  private readonly musicBrainzGate = new RateGate(1100);
  private readonly lyricsGate = new RateGate(350);
  private readonly acoustIdGate = new RateGate(400);

  constructor(private readonly catalog: CatalogDatabase) {}

  async metadata(track: TrackDetails, signal?: AbortSignal): Promise<ProviderCandidate[]> {
    const cacheKey = `mb:${track.title}:${track.artists.join(";")}:${track.album ?? ""}:${Math.round((track.durationMs ?? 0) / 1000)}`;
    const cached = this.catalog.getCached<ProviderCandidate[]>(cacheKey);
    if (cached) return cached;
    await this.musicBrainzGate.wait(signal);
    const clauses = [track.title && `recording:${quote(track.title)}`, track.artists[0] && `artist:${quote(track.artists[0])}`, track.album && `release:${quote(track.album)}`].filter(Boolean);
    if (!clauses.length) throw new Error("Add a title or artist before searching MusicBrainz");
    const url = new URL("https://musicbrainz.org/ws/2/recording/");
    url.searchParams.set("query", clauses.join(" AND "));
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "10");
    const response = await fetchWithRetry(url, { headers: { "User-Agent": this.userAgent(), Accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`MusicBrainz lookup failed (${response.status})`);
    const body = await response.json() as { recordings?: MbRecording[] };
    const candidates = (body.recordings ?? []).map((recording): ProviderCandidate => {
      const release = recording.releases?.[0];
      return {
        id: `musicbrainz:${recording.id}:${release?.id ?? ""}`,
        source: "musicbrainz",
        confidence: Math.max(0, Math.min(1, (recording.score ?? 0) / 100)),
        attribution: "Metadata from MusicBrainz",
        title: recording.title,
        artists: recording["artist-credit"]?.map((credit) => credit.artist?.name ?? credit.name),
        album: release?.title,
        albumArtist: release?.["artist-credit"]?.map((credit) => credit.name).join(" & "),
        date: release?.date,
        identifiers: { musicbrainzRecordingId: recording.id, ...(release?.id ? { musicbrainzReleaseId: release.id } : {}), ...(recording.isrcs?.[0] ? { isrc: recording.isrcs[0] } : {}) },
        ...(release?.id ? { coverUrl: `https://coverartarchive.org/release/${release.id}/front-500` } : {})
      };
    });
    this.catalog.setCached(cacheKey, candidates, 7 * 24 * 60 * 60 * 1000);
    return candidates;
  }

  async lyrics(track: TrackDetails, signal?: AbortSignal): Promise<ProviderCandidate[]> {
    if (!track.title || !track.artists[0]) throw new Error("A title and artist are required for lyric lookup");
    const cacheKey = `lyrics:${track.title}:${track.artists[0]}:${track.album ?? ""}:${Math.round((track.durationMs ?? 0) / 1000)}`;
    const cached = this.catalog.getCached<ProviderCandidate[]>(cacheKey);
    if (cached) return cached;
    await this.lyricsGate.wait(signal);
    const url = new URL("https://lrclib.net/api/search");
    url.searchParams.set("track_name", track.title);
    url.searchParams.set("artist_name", track.artists[0]);
    if (track.album) url.searchParams.set("album_name", track.album);
    const response = await fetchWithRetry(url, { headers: { "User-Agent": this.userAgent(), Accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`LRCLIB lookup failed (${response.status})`);
    const rows = await response.json() as Array<{ id: number; trackName: string; artistName: string; albumName?: string; duration?: number; plainLyrics?: string | null; syncedLyrics?: string | null }>;
    const durationSeconds = (track.durationMs ?? 0) / 1000;
    const candidates = rows.map((row): ProviderCandidate => ({
      id: `lrclib:${row.id}`, source: "lrclib",
      confidence: lyricConfidence(track, row, durationSeconds), attribution: "Lyrics from LRCLIB",
      title: row.trackName, artists: [row.artistName], album: row.albumName,
      plainLyrics: row.plainLyrics ?? null, syncedLyrics: row.syncedLyrics ?? null
    })).sort((a, b) => b.confidence - a.confidence);
    this.catalog.setCached(cacheKey, candidates, 24 * 60 * 60 * 1000);
    return candidates;
  }

  async fingerprint(track: TrackDetails, signal?: AbortSignal): Promise<ProviderCandidate[]> {
    const key = this.catalog.getSettings().acoustIdKey;
    if (!key) throw new Error("Add your private AcoustID client key in Settings first");
    let fingerprint = this.catalog.getFingerprint(track.id);
    if (!fingerprint) {
      signal?.throwIfAborted();
      fingerprint = await runFingerprint(track.absolutePath);
      signal?.throwIfAborted();
      this.catalog.setFingerprint(track.id, fingerprint.fingerprint, fingerprint.duration);
    }
    const cacheKey = `acoustid:${fingerprint.fingerprint}`;
    const cached = this.catalog.getCached<ProviderCandidate[]>(cacheKey);
    if (cached) return cached;
    await this.acoustIdGate.wait(signal);
    const url = new URL("https://api.acoustid.org/v2/lookup");
    url.searchParams.set("client", key); url.searchParams.set("format", "json");
    url.searchParams.set("duration", String(fingerprint.duration)); url.searchParams.set("fingerprint", fingerprint.fingerprint);
    url.searchParams.set("meta", "recordings recordingids releases releaseids releasegroups tracks isrcs compress");
    const response = await fetchWithRetry(url, { method: "POST", headers: { "User-Agent": this.userAgent() }, signal });
    if (!response.ok) throw new Error(`AcoustID lookup failed (${response.status})`);
    const body = await response.json() as { status: string; results?: Array<{ id: string; score: number; recordings?: MbRecording[] }> };
    if (body.status !== "ok") throw new Error("AcoustID returned an error");
    const candidates = (body.results ?? []).flatMap((result) => (result.recordings ?? []).map((recording): ProviderCandidate => ({
      id: `acoustid:${result.id}:${recording.id}`, source: "acoustid", confidence: result.score,
      attribution: "Identification from AcoustID and MusicBrainz", title: recording.title,
      artists: recording["artist-credit"]?.map((credit) => credit.artist?.name ?? credit.name),
      identifiers: { acoustId: result.id, musicbrainzRecordingId: recording.id, ...(recording.isrcs?.[0] ? { isrc: recording.isrcs[0] } : {}) }
    })));
    this.catalog.setCached(cacheKey, candidates, 30 * 24 * 60 * 60 * 1000);
    return candidates;
  }

  async downloadArtwork(rawUrl: string, signal?: AbortSignal): Promise<{ mimeType: "image/jpeg" | "image/png"; dataBase64: string }> {
    const url = new URL(rawUrl);
    if (!isAllowedArtworkUrl(url)) throw new Error("Artwork URL is not from an approved provider");
    const response = await fetchWithRetry(url, { headers: { "User-Agent": this.userAgent() }, redirect: "follow", signal });
    if (!response.ok) throw new Error(`Artwork download failed (${response.status})`);
    if (!isAllowedArtworkUrl(new URL(response.url))) throw new Error("Artwork provider redirected to an unapproved host");
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType !== "image/jpeg" && contentType !== "image/png") throw new Error("Provider returned an unsupported artwork format");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Artwork exceeds 20 MB");
    return { mimeType: contentType, dataBase64: Buffer.from(bytes).toString("base64") };
  }

  private userAgent(): string { return `LibraryTagger/${app.getVersion()} (${this.catalog.getSettings().providerContact})`; }
}

function isAllowedArtworkUrl(url: URL): boolean {
  const allowed = ["coverartarchive.org", "archive.org", "us.archive.org"];
  return url.protocol === "https:" && allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

async function fetchWithRetry(input: URL, init: RequestInit, attempts = 3): Promise<Response> {
  let response = await fetchOnce(input, init);
  for (let attempt = 1; attempt < attempts && [429, 503].includes(response.status); attempt += 1) {
    await abortableDelay(retryDelay(response.headers.get("retry-after")), init.signal ?? undefined);
    response = await fetchOnce(input, init);
  }
  return response;
}

async function fetchOnce(input: URL, init: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return await fetch(input, { ...init, signal });
}

export function retryDelay(value: string | null, now = Date.now()): number {
  if (!value) return 1000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Math.min(30_000, Math.max(1000, delay));
}

async function abortableDelay(delay: number, signal?: AbortSignal): Promise<void> {
  if (!signal) { await new Promise((resolve) => setTimeout(resolve, delay)); return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delay);
    function done(): void { signal?.removeEventListener("abort", aborted); resolve(); }
    function aborted(): void { clearTimeout(timer); reject(signal?.reason ?? new Error("Cancelled")); }
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function quote(value: string): string { return `"${value.replace(/["\\]/g, " ")}"`; }
function normalize(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
export function lyricConfidence(track: TrackDetails, row: { trackName: string; artistName: string; albumName?: string; duration?: number }, duration: number): number {
  let score = normalize(track.title ?? "") === normalize(row.trackName) ? 0.5 : 0.2;
  score += normalize(track.artists[0] ?? "") === normalize(row.artistName) ? 0.3 : 0;
  score += track.album && row.albumName && normalize(track.album) === normalize(row.albumName) ? 0.1 : 0;
  score += duration && row.duration && Math.abs(duration - row.duration) <= 2 ? 0.1 : 0;
  return Math.min(1, score);
}

async function runFingerprint(path: string): Promise<{ fingerprint: string; duration: number }> {
  const output = await run(corePath(), ["fingerprint", path]);
  const result = JSON.parse(output) as { fingerprint: string; duration: number };
  if (!result.fingerprint || !result.duration) throw new Error("Invalid fingerprint response");
  return result;
}
