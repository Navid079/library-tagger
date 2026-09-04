import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogDatabase } from "../src/main/database";
import { Organizer } from "../src/main/organizer";
import type { PrivilegeAdapter } from "../src/main/privilege";
import type { TrackDetails } from "../src/shared/models";

const noPrivilege: PrivilegeAdapter = { available: () => false, execute: async () => { throw new Error("unexpected privilege request"); } };
let directory = ""; let database: CatalogDatabase;

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "library-tagger-organizer-")); database = new CatalogDatabase(":memory:"); });
afterEach(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });

describe("organizer transactions", () => {
  it("previews, moves a track with its LRC sidecar, and safely undoes", async () => {
    const source = join(directory, "incoming.mp3"); const sidecar = join(directory, "incoming.lrc");
    await writeFile(source, "audio bytes"); await writeFile(sidecar, "[00:01.00]words");
    const library = database.addLibrary("Library", directory, directory); const info = await stat(source);
    const trackId = database.upsertTrack(trackRecord(library.id, source, info.size, info.mtimeMs));
    const organizer = new Organizer(database, noPrivilege);
    const plan = await organizer.preview({ trackIds: [trackId], destinationLibraryId: library.id, template: "{albumArtist}/{album}/{track:02} - {title}.{ext}" });
    expect(plan.canApply).toBe(true); expect(plan.items[0]?.destinationPath).toBe(join(directory, "Artist", "Album", "02 - Song.mp3"));
    const operationId = await organizer.apply(plan.id);
    const destination = plan.items[0]!.destinationPath;
    expect(await readFile(destination, "utf8")).toBe("audio bytes"); expect(await readFile(destination.replace(/\.mp3$/, ".lrc"), "utf8")).toContain("words");
    await expect(access(source)).rejects.toThrow();
    await organizer.undo(operationId);
    expect(await readFile(source, "utf8")).toBe("audio bytes"); expect(database.getTrack(trackId)?.absolutePath).toBe(source);
  });

  it("blocks an existing destination without overwriting it", async () => {
    const source = join(directory, "incoming.mp3"); await writeFile(source, "source");
    const destination = join(directory, "Artist", "Album", "02 - Song.mp3"); await writeFile(destination, "existing").catch(async () => { const { mkdir } = await import("node:fs/promises"); await mkdir(join(directory, "Artist", "Album"), { recursive: true }); await writeFile(destination, "existing"); });
    const library = database.addLibrary("Library", directory, directory); const info = await stat(source);
    const id = database.upsertTrack(trackRecord(library.id, source, info.size, info.mtimeMs));
    const plan = await new Organizer(database, noPrivilege).preview({ trackIds: [id], destinationLibraryId: library.id, template: "{albumArtist}/{album}/{track:02} - {title}.{ext}" });
    expect(plan.canApply).toBe(false); expect(plan.items[0]?.conflict).toContain("already exists"); expect(await readFile(destination, "utf8")).toBe("existing");
  });

  it("resumes an interrupted journal without repeating completed moves", async () => {
    const firstSource = join(directory, "first.mp3"); const secondSource = join(directory, "second.mp3");
    await writeFile(firstSource, "first audio"); await writeFile(secondSource, "second audio");
    const library = database.addLibrary("Library", directory, directory);
    const firstInfo = await stat(firstSource); const secondInfo = await stat(secondSource);
    const firstId = database.upsertTrack({ ...trackRecord(library.id, firstSource, firstInfo.size, firstInfo.mtimeMs), filename: "first.mp3", relativePath: "first.mp3", title: "First", sidecarLyrics: null, lyrics: { embedded: false, sidecar: false, synchronized: false, instrumental: false } });
    const secondId = database.upsertTrack({ ...trackRecord(library.id, secondSource, secondInfo.size, secondInfo.mtimeMs), filename: "second.mp3", relativePath: "second.mp3", title: "Second", trackNumber: 3, sidecarLyrics: null, lyrics: { embedded: false, sidecar: false, synchronized: false, instrumental: false } });
    const organizer = new Organizer(database, noPrivilege);
    const plan = await organizer.preview({ trackIds: [firstId, secondId], destinationLibraryId: library.id, template: "{albumArtist}/{album}/{track:02} - {title}.{ext}" });
    const first = plan.items[0]!; const operationId = "interrupted-operation";
    await mkdir(join(directory, "Artist", "Album"), { recursive: true });
    await rename(first.sourcePath, first.destinationPath);
    database.updateTrackPath(first.trackId, library.id, first.destinationPath, "Artist/Album/02 - First.mp3", "02 - First.mp3");
    database.saveOperation(operationId, "organize", "failed", plan, [{ trackId: first.trackId, from: first.destinationPath, to: first.sourcePath, sidecarFrom: null, sidecarTo: null, hash: first.sourceHash }]);

    expect(organizer.recoverable()).toEqual([{ id: operationId, completed: 1, total: 2, status: "failed" }]);
    await organizer.resume(operationId);
    expect(await readFile(first.destinationPath, "utf8")).toBe("first audio");
    expect(await readFile(plan.items[1]!.destinationPath, "utf8")).toBe("second audio");
    expect(database.getOperation(operationId)?.status).toBe("completed");
  });

  it("rejects a source changed after preview", async () => {
    const source = join(directory, "incoming.mp3"); await writeFile(source, "original");
    const library = database.addLibrary("Library", directory, directory); const info = await stat(source);
    const id = database.upsertTrack(trackRecord(library.id, source, info.size, info.mtimeMs));
    const organizer = new Organizer(database, noPrivilege);
    const plan = await organizer.preview({ trackIds: [id], destinationLibraryId: library.id, template: "{albumArtist}/{album}/{track:02} - {title}.{ext}" });
    await writeFile(source, "changed after preview");
    await expect(organizer.apply(plan.id)).rejects.toThrow("Source changed after preview");
    expect(await readFile(source, "utf8")).toBe("changed after preview");
  });
});

function trackRecord(libraryId: number, absolutePath: string, size: number, modifiedMs: number): Omit<TrackDetails, "id"> & { scanToken: string } {
  return { libraryId, filename: "incoming.mp3", relativePath: "incoming.mp3", absolutePath, title: "Song", artists: ["Artist"], albumArtist: "Artist", albumArtists: ["Artist"], album: "Album", trackNumber: 2, trackTotal: 10, discNumber: 1, discTotal: 1, date: null, year: null, genres: [], composers: [], comment: null, identifiers: {}, embeddedLyrics: null, sidecarLyrics: "[00:01.00]words", advancedTags: [], durationMs: null, format: "mp3", writable: true, hasCover: false, coverUrl: null, lyrics: { embedded: false, sidecar: true, synchronized: true, instrumental: false }, available: true, error: null, size, modifiedMs, scanToken: "scan" };
}
