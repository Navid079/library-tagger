import { afterEach, describe, expect, it } from "vitest";
import { CatalogDatabase } from "../src/main/database";
import type { TrackDetails } from "../src/shared/models";

let database: CatalogDatabase | undefined;
afterEach(() => database?.close());

describe("catalog", () => {
  it("persists libraries and searchable normalized track data", () => {
    database = new CatalogDatabase(":memory:");
    const library = database.addLibrary("Music", "/music", "/music");
    const track: Omit<TrackDetails, "id"> & { scanToken: string } = {
      libraryId: library.id, filename: "file.mp3", relativePath: "Album/file.mp3", absolutePath: "/music/Album/file.mp3",
      title: "Signal", artists: ["Artist"], albumArtist: "Artist", albumArtists: ["Artist"], album: "Album", trackNumber: 1,
      trackTotal: 1, discNumber: 1, discTotal: 1, date: "2024", year: 2024, genres: ["Rock"], composers: [], comment: null,
      identifiers: {}, embeddedLyrics: "words", sidecarLyrics: null, advancedTags: [], durationMs: 90000, format: "mp3", writable: true,
      hasCover: false, coverUrl: null, lyrics: { embedded: true, sidecar: false, synchronized: false, instrumental: false }, available: true, error: null,
      size: 500, modifiedMs: 100, scanToken: "scan-1"
    };
    const id = database.upsertTrack(track);
    database.finishScan(library.id, "scan-1");
    expect(database.queryTracks({ libraryId: library.id, search: "Signal", group: "tracks", sortBy: "title", sortDirection: "asc", offset: 0, limit: 20 })).toMatchObject({ total: 1, items: [{ id, title: "Signal", hasCover: false }] });
    expect(database.getTrack(id)?.lyrics.embedded).toBe(true);
  });

  it("retains missing tracks as unavailable after a later scan", () => {
    database = new CatalogDatabase(":memory:"); const library = database.addLibrary("Music", "/music", "/music");
    database.upsertTrack({ libraryId: library.id, filename: "a.mp3", relativePath: "a.mp3", absolutePath: "/music/a.mp3", title: null, artists: [], albumArtist: null, albumArtists: [], album: null, trackNumber: null, trackTotal: null, discNumber: null, discTotal: null, date: null, year: null, genres: [], composers: [], comment: null, identifiers: {}, embeddedLyrics: null, sidecarLyrics: null, advancedTags: [], durationMs: null, format: "mp3", writable: true, hasCover: false, coverUrl: null, lyrics: { embedded: false, sidecar: false, synchronized: false, instrumental: false }, available: true, error: null, size: 1, modifiedMs: 1, scanToken: "old" });
    database.finishScan(library.id, "new");
    expect(database.queryTracks({ search: "", group: "tracks", sortBy: "title", sortDirection: "asc", offset: 0, limit: 20 }).items[0]?.available).toBe(false);
  });
});
