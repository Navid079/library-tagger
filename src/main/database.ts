import { DatabaseSync } from "node:sqlite";
import type { Library, Settings, TrackDetails, TrackPage, TrackQuery, TrackSummary } from "../shared/models";

type TrackWrite = Omit<TrackDetails, "id"> & { scanToken: string; device?: number; inode?: number };

const defaultSettings: Settings = {
  providerContact: "private desktop app",
  acoustIdKey: "",
  organizationTemplate: "{albumArtist}/{album}/{discFolder}{track:02} - {title}.{ext}"
};

export class CatalogDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS libraries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        online INTEGER NOT NULL DEFAULT 1,
        last_scanned_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL UNIQUE,
        title TEXT,
        artists_json TEXT NOT NULL DEFAULT '[]',
        album_artists_json TEXT NOT NULL DEFAULT '[]',
        album TEXT,
        track_number INTEGER,
        track_total INTEGER,
        disc_number INTEGER,
        disc_total INTEGER,
        date TEXT,
        year INTEGER,
        genres_json TEXT NOT NULL DEFAULT '[]',
        composers_json TEXT NOT NULL DEFAULT '[]',
        comment TEXT,
        identifiers_json TEXT NOT NULL DEFAULT '{}',
        embedded_lyrics TEXT,
        sidecar_lyrics TEXT,
        advanced_tags_json TEXT NOT NULL DEFAULT '[]',
        format TEXT NOT NULL,
        duration_ms REAL,
        writable INTEGER NOT NULL DEFAULT 0,
        cover_hash TEXT,
        size REAL NOT NULL,
        modified_ms REAL NOT NULL,
        device REAL,
        inode REAL,
        error TEXT,
        available INTEGER NOT NULL DEFAULT 1,
        scan_token TEXT NOT NULL,
        fingerprint TEXT,
        fingerprint_duration INTEGER,
        UNIQUE(library_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_library ON tracks(library_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        inverse_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(tracks)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("device")) this.db.exec("ALTER TABLE tracks ADD COLUMN device REAL");
    if (!columns.has("inode")) this.db.exec("ALTER TABLE tracks ADD COLUMN inode REAL");
    if (!columns.has("error")) this.db.exec("ALTER TABLE tracks ADD COLUMN error TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_identity ON tracks(library_id, device, inode)");
  }

  listLibraries(): Library[] {
    const rows = this.db.prepare(`
      SELECT l.*, COUNT(t.id) AS track_count
      FROM libraries l LEFT JOIN tracks t ON t.library_id=l.id AND t.available=1
      GROUP BY l.id ORDER BY l.name COLLATE NOCASE
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      canonicalPath: String(row.canonical_path),
      online: Boolean(row.online),
      trackCount: Number(row.track_count),
      lastScannedAt: row.last_scanned_at ? String(row.last_scanned_at) : null
    }));
  }

  addLibrary(name: string, rootPath: string, canonicalPath: string): Library {
    this.db.prepare("INSERT INTO libraries(name, root_path, canonical_path) VALUES (?, ?, ?)").run(name, rootPath, canonicalPath);
    return this.listLibraries().find((item) => item.canonicalPath === canonicalPath)!;
  }

  getLibrary(id: number): Library | undefined {
    return this.listLibraries().find((library) => library.id === id);
  }

  findOverlappingLibrary(canonicalPath: string): Library | undefined {
    const normalized = canonicalPath.endsWith("/") ? canonicalPath : `${canonicalPath}/`;
    return this.listLibraries().find((library) => {
      const existing = library.canonicalPath.endsWith("/") ? library.canonicalPath : `${library.canonicalPath}/`;
      return normalized.startsWith(existing) || existing.startsWith(normalized);
    });
  }

  removeLibrary(id: number): void {
    this.db.prepare("DELETE FROM libraries WHERE id=?").run(id);
  }

  setLibraryScanState(id: number, online: boolean, timestamp: string | null): void {
    this.db.prepare("UPDATE libraries SET online=?, last_scanned_at=COALESCE(?, last_scanned_at) WHERE id=?")
      .run(online ? 1 : 0, timestamp, id);
  }

  upsertTrack(track: TrackWrite): number {
    const statement = this.db.prepare(`
      INSERT INTO tracks (
        library_id, filename, relative_path, absolute_path, title, artists_json, album_artists_json,
        album, track_number, track_total, disc_number, disc_total, date, year, genres_json,
        composers_json, comment, identifiers_json, embedded_lyrics, sidecar_lyrics, advanced_tags_json,
        format, duration_ms, writable, cover_hash, size, modified_ms, device, inode, error, available, scan_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(absolute_path) DO UPDATE SET
        library_id=excluded.library_id, filename=excluded.filename, relative_path=excluded.relative_path,
        title=excluded.title, artists_json=excluded.artists_json, album_artists_json=excluded.album_artists_json,
        album=excluded.album, track_number=excluded.track_number, track_total=excluded.track_total,
        disc_number=excluded.disc_number, disc_total=excluded.disc_total, date=excluded.date, year=excluded.year,
        genres_json=excluded.genres_json, composers_json=excluded.composers_json, comment=excluded.comment,
        identifiers_json=excluded.identifiers_json, embedded_lyrics=excluded.embedded_lyrics,
        sidecar_lyrics=excluded.sidecar_lyrics, advanced_tags_json=excluded.advanced_tags_json,
        format=excluded.format, duration_ms=excluded.duration_ms, writable=excluded.writable,
        cover_hash=excluded.cover_hash, size=excluded.size, modified_ms=excluded.modified_ms,
        device=excluded.device, inode=excluded.inode, error=excluded.error,
        available=1, scan_token=excluded.scan_token
      RETURNING id
    `);
    const row = statement.get(
      track.libraryId, track.filename, track.relativePath, track.absolutePath, track.title,
      JSON.stringify(track.artists), JSON.stringify(track.albumArtists), track.album, track.trackNumber,
      track.trackTotal, track.discNumber, track.discTotal, track.date, track.year,
      JSON.stringify(track.genres), JSON.stringify(track.composers), track.comment,
      JSON.stringify(track.identifiers), track.embeddedLyrics, track.sidecarLyrics,
      JSON.stringify(track.advancedTags), track.format, track.durationMs, track.writable ? 1 : 0,
      track.coverUrl?.replace("media://cover/", "") ?? null, track.size, track.modifiedMs,
      track.device ?? null, track.inode ?? null, track.error, track.scanToken
    ) as { id: number };
    return Number(row.id);
  }

  finishScan(libraryId: number, scanToken: string): void {
    this.db.prepare("UPDATE tracks SET available=0 WHERE library_id=? AND scan_token<>?").run(libraryId, scanToken);
    this.setLibraryScanState(libraryId, true, new Date().toISOString());
  }

  getTrack(id: number): TrackDetails | undefined {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toTrackDetails(row) : undefined;
  }

  queryTracks(query: TrackQuery): TrackPage {
    const where: string[] = ["1=1"];
    const args: Array<string | number> = [];
    if (query.libraryId) { where.push("library_id=?"); args.push(query.libraryId); }
    if (query.search.trim()) {
      where.push("(filename LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' OR artists_json LIKE ? ESCAPE '\\' OR relative_path LIKE ? ESCAPE '\\')");
      const escaped = query.search.trim().replace(/[\\%_]/g, "\\$&");
      for (let i = 0; i < 5; i += 1) args.push(`%${escaped}%`);
    }
    const columns = { filename: "filename", title: "COALESCE(title, filename)", artist: "artists_json", album: "COALESCE(album, '')", year: "COALESCE(year, 0)", trackNumber: "COALESCE(track_number, 0)", format: "format", path: "relative_path" } as const;
    const order = columns[query.sortBy];
    const whereSql = where.join(" AND ");
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM tracks WHERE ${whereSql}`).get(...args) as { count: number }).count);
    const rows = this.db.prepare(`SELECT * FROM tracks WHERE ${whereSql} ORDER BY ${order} COLLATE NOCASE ${query.sortDirection === "desc" ? "DESC" : "ASC"} LIMIT ? OFFSET ?`)
      .all(...args, query.limit, query.offset) as Record<string, unknown>[];
    return { items: rows.map((row) => this.toTrackSummary(row)), total };
  }

  updateTrackPath(id: number, libraryId: number, absolutePath: string, relativePath: string, filename: string): void {
    this.db.prepare("UPDATE tracks SET library_id=?, absolute_path=?, relative_path=?, filename=?, available=1 WHERE id=?")
      .run(libraryId, absolutePath, relativePath, filename, id);
  }

  getTrackByPath(absolutePath: string): TrackDetails | undefined {
    const row = this.db.prepare("SELECT * FROM tracks WHERE absolute_path=?").get(absolutePath) as Record<string, unknown> | undefined;
    return row ? this.toTrackDetails(row) : undefined;
  }

  getTrackByIdentity(libraryId: number, device: number, inode: number): TrackDetails | undefined {
    if (!inode) return undefined;
    const row = this.db.prepare("SELECT * FROM tracks WHERE library_id=? AND device=? AND inode=? LIMIT 1").get(libraryId, device, inode) as Record<string, unknown> | undefined;
    return row ? this.toTrackDetails(row) : undefined;
  }

  getTrackForSidecar(sidecarPath: string): TrackDetails | undefined {
    const base = sidecarPath.replace(/\.lrc$/i, "");
    const row = this.db.prepare("SELECT * FROM tracks WHERE substr(absolute_path, 1, length(absolute_path) - length(format) - 1)=? LIMIT 1").get(base) as Record<string, unknown> | undefined;
    return row ? this.toTrackDetails(row) : undefined;
  }

  markTrackScanned(id: number, scanToken: string): void {
    this.db.prepare("UPDATE tracks SET available=1, scan_token=? WHERE id=?").run(scanToken, id);
  }

  saveOperation(id: string, kind: string, status: string, payload: unknown, inverse?: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO operations(id, kind, status, payload_json, inverse_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, kind, status, JSON.stringify(payload), inverse ? JSON.stringify(inverse) : null, new Date().toISOString());
  }

  getOperation(id: string): { kind: string; status: string; payload: unknown; inverse: unknown } | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { kind: String(row.kind), status: String(row.status), payload: JSON.parse(String(row.payload_json)), inverse: row.inverse_json ? JSON.parse(String(row.inverse_json)) : null };
  }

  listRecoverableOperations(): Array<{ id: string; completed: number; total: number; status: "running" | "failed" }> {
    const rows = this.db.prepare("SELECT id, status, payload_json, inverse_json FROM operations WHERE kind='organize' AND status IN ('running', 'failed') ORDER BY created_at DESC").all() as Array<{ id: string; status: "running" | "failed"; payload_json: string; inverse_json: string | null }>;
    return rows.map((row) => ({ id: row.id, status: row.status, completed: row.inverse_json ? (JSON.parse(row.inverse_json) as unknown[]).length : 0, total: (JSON.parse(row.payload_json) as { items: unknown[] }).items.length }));
  }

  getSettings(): Settings {
    const entries = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: keyof Settings; value: string }>;
    const result = { ...defaultSettings };
    for (const row of entries) if (row.key in result) result[row.key] = row.value;
    if (process.env.ACOUSTID_CLIENT_KEY) result.acoustIdKey = process.env.ACOUSTID_CLIENT_KEY;
    return result;
  }

  setSettings(settings: Settings): Settings {
    const statement = this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(settings)) statement.run(key, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSettings();
  }

  getCached<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM provider_cache WHERE cache_key=? AND expires_at>?").get(key, Date.now()) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  setCached(key: string, value: unknown, ttlMs: number): void {
    this.db.prepare("INSERT OR REPLACE INTO provider_cache(cache_key, value_json, expires_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now() + ttlMs);
  }

  setFingerprint(id: number, fingerprint: string, duration: number): void {
    this.db.prepare("UPDATE tracks SET fingerprint=?, fingerprint_duration=? WHERE id=?").run(fingerprint, duration, id);
  }

  getFingerprint(id: number): { fingerprint: string; duration: number } | undefined {
    return this.db.prepare("SELECT fingerprint, fingerprint_duration AS duration FROM tracks WHERE id=? AND fingerprint IS NOT NULL")
      .get(id) as { fingerprint: string; duration: number } | undefined;
  }

  private toTrackSummary(row: Record<string, unknown>): TrackSummary {
    const embedded = Boolean(row.embedded_lyrics);
    const sidecarText = row.sidecar_lyrics ? String(row.sidecar_lyrics) : "";
    const synchronized = /^\s*\[\d{1,3}:\d{2}(?:\.\d{1,3})?]/m.test(sidecarText);
    const artists = JSON.parse(String(row.artists_json)) as string[];
    const albumArtists = JSON.parse(String(row.album_artists_json)) as string[];
    const coverHash = row.cover_hash ? String(row.cover_hash) : null;
    return {
      id: Number(row.id), libraryId: Number(row.library_id), filename: String(row.filename),
      relativePath: String(row.relative_path), absolutePath: String(row.absolute_path),
      title: row.title ? String(row.title) : null, artists,
      albumArtist: albumArtists[0] ?? null, album: row.album ? String(row.album) : null,
      trackNumber: row.track_number == null ? null : Number(row.track_number),
      discNumber: row.disc_number == null ? null : Number(row.disc_number),
      year: row.year == null ? null : Number(row.year), durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      format: String(row.format), writable: Boolean(row.writable), hasCover: Boolean(coverHash),
      coverUrl: coverHash ? `media://cover/${coverHash}` : null,
      lyrics: { embedded, sidecar: Boolean(sidecarText), synchronized, instrumental: false },
      available: Boolean(row.available), error: row.error ? String(row.error) : null,
      size: Number(row.size), modifiedMs: Number(row.modified_ms)
    };
  }

  private toTrackDetails(row: Record<string, unknown>): TrackDetails {
    return {
      ...this.toTrackSummary(row),
      albumArtists: JSON.parse(String(row.album_artists_json)) as string[],
      trackTotal: row.track_total == null ? null : Number(row.track_total),
      discTotal: row.disc_total == null ? null : Number(row.disc_total),
      date: row.date ? String(row.date) : null,
      genres: JSON.parse(String(row.genres_json)) as string[],
      composers: JSON.parse(String(row.composers_json)) as string[],
      comment: row.comment ? String(row.comment) : null,
      identifiers: JSON.parse(String(row.identifiers_json)) as Record<string, string>,
      embeddedLyrics: row.embedded_lyrics ? String(row.embedded_lyrics) : null,
      sidecarLyrics: row.sidecar_lyrics ? String(row.sidecar_lyrics) : null,
      advancedTags: JSON.parse(String(row.advanced_tags_json)) as TrackDetails["advancedTags"]
    };
  }
}
