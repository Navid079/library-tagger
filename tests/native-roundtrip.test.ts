import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFile } from "music-metadata";
import { CatalogDatabase } from "../src/main/database";
import { JobManager } from "../src/main/jobs";
import { LibraryScanner } from "../src/main/scanner";
import { TagWriter } from "../src/main/tag-writer";
import type { PrivilegeAdapter } from "../src/main/privilege";
import type { TrackDetails } from "../src/shared/models";

const core = join(process.cwd(), "native/target/debug/library-tagger-core");
const enabled = existsSync(core) && commandExists("ffmpeg");
let directory = "";
const formats = [
  ["mp3", "libmp3lame", []], ["flac", "flac", []], ["m4a", "aac", []], ["aac", "aac", ["-f", "adts"]],
  ["ogg", "libvorbis", []], ["opus", "libopus", []]
] as const;
const cover = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe.runIf(enabled)("native real-format round trips", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "library-tagger-formats-"));
    for (const [extension, codec, extra] of formats) execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", codec, ...extra, join(directory, `test.${extension}`)]);
  }, 30_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it.each(formats)("writes text, lyrics, and artwork to %s", async (extension) => {
    const path = join(directory, `test.${extension}`);
    const audioBefore = decodedAudioHash(path);
    execFileSync(core, ["write"], { input: JSON.stringify({ path, patch: { title: "Round Trip", artists: ["Library Tagger"], album: "Fixtures", embeddedLyrics: "Test lyric", cover: { mimeType: "image/png", dataBase64: cover } } }) });
    const metadata = await parseFile(path);
    expect(metadata.common).toMatchObject({ title: "Round Trip", artist: "Library Tagger", album: "Fixtures" });
    expect(metadata.common.lyrics?.[0]?.text).toBe("Test lyric");
    expect(metadata.common.picture?.[0]?.format).toBe("image/png");
    expect(decodedAudioHash(path)).toBe(audioBefore);
  });

  it("produces an AcoustID-compatible compressed fingerprint", () => {
    const path = join(directory, "fingerprint.mp3");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=523:duration=15", "-c:a", "libmp3lame", path]);
    const result = JSON.parse(execFileSync(core, ["fingerprint", path], { encoding: "utf8" })) as { duration: number; fingerprint: string };
    expect(result.duration).toBeGreaterThanOrEqual(14); expect(result.fingerprint).toMatch(/^[A-Za-z0-9_-]+$/);
  }, 30_000);

  it("preserves unpatched tags and removes only explicitly deleted identifiers or advanced tags", async () => {
    const path = join(directory, "preservation.mp3");
    await copyFile(join(directory, "test.mp3"), path);
    execFileSync(core, ["write"], { input: JSON.stringify({ path, patch: { identifiers: { isrc: "USAAA2600001" }, advancedTags: [{ key: "ID3v2:TCOP", value: "Fixture copyright" }] } }) });
    execFileSync(core, ["write"], { input: JSON.stringify({ path, patch: { title: "Preserved", removedIdentifiers: ["isrc"] } }) });
    let metadata = await parseFile(path);
    expect(metadata.common.album).toBe("Fixtures");
    expect(metadata.common.isrc ?? []).not.toContain("USAAA2600001");
    expect(Object.values(metadata.native).flat().some((tag) => tag.id === "TCOP" && tag.value === "Fixture copyright")).toBe(true);
    execFileSync(core, ["write"], { input: JSON.stringify({ path, patch: { removedAdvancedTags: ["ID3v2:TCOP"] } }) });
    metadata = await parseFile(path);
    expect(Object.values(metadata.native).flat().some((tag) => tag.id === "TCOP")).toBe(false);
  });

  it("indexes a real library and reports tag, cover, and lyric state", async () => {
    const database = new CatalogDatabase(":memory:");
    const library = database.addLibrary("Fixtures", directory, directory);
    const scanner = new LibraryScanner(database, join(directory, ".covers"), new JobManager());
    try {
      await scanner.scan(library);
      for (let attempt = 0; attempt < 100 && !database.getLibrary(library.id)?.lastScannedAt; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      const page = database.queryTracks({ libraryId: library.id, search: "Round Trip", group: "tracks", sortBy: "title", sortDirection: "asc", offset: 0, limit: 20 });
      expect(page.total).toBe(6);
      expect(page.items.every((track) => track.hasCover && track.lyrics.embedded && track.writable)).toBe(true);
    } finally { await scanner.close(); database.close(); }
  });

  it("atomically writes through the service and rejects a stale second save", async () => {
    const path = join(directory, "atomic.mp3"); await copyFile(join(directory, "test.mp3"), path); const info = await stat(path);
    const track: TrackDetails = { id: 100, libraryId: 1, filename: "atomic.mp3", relativePath: "atomic.mp3", absolutePath: path, title: "Round Trip", artists: ["Library Tagger"], albumArtist: null, albumArtists: [], album: "Fixtures", trackNumber: null, trackTotal: null, discNumber: null, discTotal: null, date: null, year: null, genres: [], composers: [], comment: null, identifiers: {}, embeddedLyrics: "Test lyric", sidecarLyrics: null, advancedTags: [], durationMs: 1000, format: "mp3", writable: true, hasCover: true, coverUrl: null, lyrics: { embedded: true, sidecar: false, synchronized: false, instrumental: false }, available: true, error: null, size: info.size, modifiedMs: info.mtimeMs };
    const privilege: PrivilegeAdapter = { available: () => false, execute: async () => { throw new Error("unexpected privilege request"); } };
    const writer = new TagWriter(privilege, join(directory, "staging"), () => [directory]);
    const patch = { title: "Atomic Save", expectedSize: info.size, expectedModifiedMs: info.mtimeMs };
    await writer.write(track, patch);
    expect((await parseFile(path)).common.title).toBe("Atomic Save");
    await expect(writer.write(track, patch)).rejects.toThrow("changed outside");
    expect((await readdir(directory)).some((name) => name.startsWith(".library-tagger-"))).toBe(false);
  });
});

function commandExists(command: string): boolean {
  return !spawnSync(command, ["-version"], { stdio: "ignore", shell: false }).error;
}

function decodedAudioHash(path: string): string {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"], { encoding: "utf8" }).trim();
}
