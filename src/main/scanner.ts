import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join, relative } from "node:path";
import { mkdir, opendir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { parseFile } from "music-metadata";
import { editableExtensions, type Library, type TrackDetails } from "../shared/models";
import { CatalogDatabase } from "./database";
import { JobManager } from "./jobs";

const audioExtensions = new Set(["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif", "ape", "mpc", "wv", "wma", "dsf"]);

export class LibraryScanner {
  private readonly watchers = new Map<number, FSWatcher>();

  constructor(private readonly catalog: CatalogDatabase, private readonly coverCache: string, private readonly jobs: JobManager) {}

  async scan(library: Library): Promise<string> {
    const job = this.jobs.create("scan", `Scanning ${library.name}`);
    void this.runScan(library, job.signal, job.emit).catch((error: unknown) => {
      job.emit({ status: job.signal.aborted ? "cancelled" : "failed", error: errorMessage(error), message: `Scan failed: ${library.name}` });
    });
    return job.id;
  }

  async watch(library: Library): Promise<void> {
    await this.watchers.get(library.id)?.close();
    const watcher = chokidar.watch(library.canonicalPath, { ignoreInitial: true, followSymlinks: false, awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 150 } });
    const refresh = (path: string): void => {
      const extension = extname(path).slice(1).toLowerCase();
      if (extension === "lrc") {
        const track = this.catalog.getTrackForSidecar(path);
        if (track) void this.scanSingle(library, track.absolutePath, `watch-${Date.now()}`).catch(() => undefined);
        return;
      }
      if (!audioExtensions.has(extension)) return;
      void this.scanSingle(library, path, `watch-${Date.now()}`).catch(() => undefined);
    };
    watcher.on("add", refresh).on("change", refresh).on("unlink", (path) => extname(path).toLowerCase() === ".lrc" ? refresh(path) : void this.scan(library));
    this.watchers.set(library.id, watcher);
  }

  async unwatch(id: number): Promise<void> {
    await this.watchers.get(id)?.close();
    this.watchers.delete(id);
  }

  async close(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close()));
    this.watchers.clear();
  }

  async refreshTrack(id: number): Promise<void> {
    const track = this.catalog.getTrack(id);
    if (!track) throw new Error("Track not found");
    const library = this.catalog.getLibrary(track.libraryId);
    if (!library) throw new Error("Library not found");
    await this.scanSingle(library, track.absolutePath, `refresh-${Date.now()}`);
  }

  private async runScan(library: Library, signal: AbortSignal, emit: (patch: Parameters<ReturnType<JobManager["create"]>["emit"]>[0]) => void): Promise<void> {
    const token = randomUUID();
    let completed = 0;
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(library.rootPath); }
    catch { this.catalog.setLibraryScanState(library.id, false, null); throw new Error("Library directory is not readable or is offline"); }

    for await (const path of walkAudio(canonicalRoot, signal)) {
      if (signal.aborted) break;
      try { await this.scanSingle(library, path, token); }
      catch (error) { await this.recordScanError(library, path, token, error); }
      completed += 1;
      emit({ completed, message: `Indexed ${basename(path)}` });
    }
    if (signal.aborted) { emit({ status: "cancelled", completed, message: "Scan cancelled" }); return; }
    this.catalog.finishScan(library.id, token);
    await this.watch(library);
    emit({ status: "completed", completed, total: completed, message: `Indexed ${completed} tracks` });
  }

  private async scanSingle(library: Library, path: string, token: string): Promise<void> {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return;
    const extension = extname(path).slice(1).toLowerCase();
    const identityMatch = this.catalog.getTrackByIdentity(library.id, fileStat.dev, fileStat.ino);
    const identityOriginalStillExists = identityMatch && identityMatch.absolutePath !== path
      ? await stat(identityMatch.absolutePath).then(() => true, () => false)
      : false;
    if (identityMatch && identityMatch.absolutePath !== path && !identityOriginalStillExists) this.catalog.updateTrackPath(identityMatch.id, library.id, path, relative(library.canonicalPath, path), basename(path));
    const existing = this.catalog.getTrackByPath(path);
    const sidecarPath = path.slice(0, -extname(path).length) + ".lrc";
    const sidecarLyrics = await readFile(sidecarPath, "utf8").catch(() => null);
    if (existing && existing.size === fileStat.size && Math.abs(existing.modifiedMs - fileStat.mtimeMs) <= 2 && existing.sidecarLyrics === sidecarLyrics) {
      this.catalog.markTrackScanned(existing.id, token);
      return;
    }
    const metadata = await parseFile(path, { duration: true, skipCovers: false });
    const common = metadata.common;
    const picture = common.picture?.[0];
    let coverUrl: string | null = null;
    if (picture) {
      const hash = createHash("sha256").update(picture.data).digest("hex");
      await mkdir(this.coverCache, { recursive: true });
      await writeFile(join(this.coverCache, hash), picture.data, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      coverUrl = `media://cover/${hash}`;
    }
    const date = common.date ?? (common.year ? String(common.year) : null);
    const identifiers: Record<string, string> = {};
    if (common.musicbrainz_recordingid) identifiers.musicbrainzRecordingId = common.musicbrainz_recordingid;
    if (common.musicbrainz_albumid) identifiers.musicbrainzReleaseId = common.musicbrainz_albumid;
    if (common.isrc?.[0]) identifiers.isrc = common.isrc[0];
    const advancedTags = Object.entries(metadata.native).flatMap(([tagType, tags]) => tags.flatMap((tag) => {
      const value = typeof tag.value === "string" || typeof tag.value === "number" ? String(tag.value) : null;
      return value && isAdvancedTagId(tag.id) ? [{ key: `${tagType}:${tag.id}`, value }] : [];
    })).slice(0, 500);
    const details: Omit<TrackDetails, "id"> & { scanToken: string; device: number; inode: number } = {
      libraryId: library.id,
      filename: basename(path), relativePath: relative(library.canonicalPath, path), absolutePath: path,
      title: common.title ?? null, artists: common.artists ?? (common.artist ? [common.artist] : []),
      albumArtist: common.albumartist ?? null, albumArtists: common.albumartist ? [common.albumartist] : [],
      album: common.album ?? null, trackNumber: common.track.no ?? null, trackTotal: common.track.of ?? null,
      discNumber: common.disk.no ?? null, discTotal: common.disk.of ?? null,
      date, year: common.year ?? (date ? Number.parseInt(date.slice(0, 4), 10) || null : null),
      genres: common.genre ?? [], composers: common.composer?.map((entry) => entry) ?? [],
      comment: common.comment?.map((item) => item.text).filter(Boolean).join("\n") || null,
      identifiers, embeddedLyrics: common.lyrics?.map((item) => item.text).filter(Boolean).join("\n") || null,
      sidecarLyrics, advancedTags, durationMs: metadata.format.duration ? metadata.format.duration * 1000 : null,
      format: extension, writable: (editableExtensions as readonly string[]).includes(extension),
      hasCover: Boolean(picture), coverUrl,
      lyrics: { embedded: Boolean(common.lyrics?.length), sidecar: Boolean(sidecarLyrics), synchronized: Boolean(sidecarLyrics && /^\s*\[\d{1,3}:\d{2}/m.test(sidecarLyrics)), instrumental: false },
      available: true, error: null, size: fileStat.size, modifiedMs: fileStat.mtimeMs,
      device: fileStat.dev, inode: fileStat.ino, scanToken: token
    };
    this.catalog.upsertTrack(details);
  }

  private async recordScanError(library: Library, path: string, token: string, error: unknown): Promise<void> {
    let fileStat;
    try { fileStat = await stat(path); } catch { return; }
    if (!fileStat.isFile()) return;
    const extension = extname(path).slice(1).toLowerCase();
    const existing = this.catalog.getTrackByPath(path);
    this.catalog.upsertTrack({
      libraryId: library.id, filename: basename(path), relativePath: relative(library.canonicalPath, path), absolutePath: path,
      title: existing?.title ?? null, artists: existing?.artists ?? [], albumArtist: existing?.albumArtist ?? null,
      albumArtists: existing?.albumArtists ?? [], album: existing?.album ?? null, trackNumber: existing?.trackNumber ?? null,
      trackTotal: existing?.trackTotal ?? null, discNumber: existing?.discNumber ?? null, discTotal: existing?.discTotal ?? null,
      date: existing?.date ?? null, year: existing?.year ?? null, genres: existing?.genres ?? [], composers: existing?.composers ?? [],
      comment: existing?.comment ?? null, identifiers: existing?.identifiers ?? {}, embeddedLyrics: existing?.embeddedLyrics ?? null,
      sidecarLyrics: existing?.sidecarLyrics ?? null, advancedTags: existing?.advancedTags ?? [], durationMs: existing?.durationMs ?? null,
      format: extension, writable: false, hasCover: existing?.hasCover ?? false, coverUrl: existing?.coverUrl ?? null,
      lyrics: existing?.lyrics ?? { embedded: false, sidecar: false, synchronized: false, instrumental: false }, available: true,
      error: errorMessage(error).slice(0, 500), size: fileStat.size, modifiedMs: fileStat.mtimeMs,
      device: fileStat.dev, inode: fileStat.ino, scanToken: token
    });
  }
}

async function* walkAudio(root: string, signal: AbortSignal): AsyncGenerator<string> {
  const pending = [root];
  while (pending.length) {
    if (signal.aborted) return;
    const current = pending.pop()!;
    const directory = await opendir(current);
    for await (const entry of directory) {
      if (signal.aborted) return;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && audioExtensions.has(extname(entry.name).slice(1).toLowerCase())) yield path;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdvancedTagId(id: string): boolean {
  return !/^(TIT2|TITLE|©nam|TPE1|ARTIST|©ART|TPE2|ALBUMARTIST|aART|TALB|ALBUM|©alb|TRCK|TRACKNUMBER|TPOS|DISCNUMBER|TDRC|DATE|YEAR|TCON|GENRE|©gen|TCOM|COMPOSER|©wrt|COMM|COMMENT|USLT|LYRICS|UNSYNCEDLYRICS|APIC|METADATA_BLOCK_PICTURE|COVERART|covr|MUSICBRAINZ_TRACKID|MUSICBRAINZ_ALBUMID|ISRC)$/i.test(id);
}
