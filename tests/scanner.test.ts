import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogDatabase } from "../src/main/database";
import { JobManager } from "../src/main/jobs";
import { LibraryScanner } from "../src/main/scanner";

let directory = "";
let database: CatalogDatabase;
let scanner: LibraryScanner;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "library-tagger-scanner-"));
  database = new CatalogDatabase(":memory:");
  scanner = new LibraryScanner(database, join(directory, ".covers"), new JobManager());
});

afterEach(async () => {
  await scanner.close();
  database.close();
  await rm(directory, { recursive: true, force: true });
});

describe("library scanning", () => {
  it("retains corrupt audio as an error row and continues the scan", async () => {
    await writeFile(join(directory, "broken.m4a"), Buffer.from("xxxxftyp"));
    const library = database.addLibrary("Music", directory, directory);
    await scanner.scan(library);
    await waitFor(() => database.getLibrary(library.id)?.lastScannedAt != null);
    const page = database.queryTracks({ libraryId: library.id, search: "", group: "tracks", sortBy: "filename", sortDirection: "asc", offset: 0, limit: 20 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ filename: "broken.m4a", writable: false, available: true });
    expect(page.items[0]?.error).toBeTruthy();
  });

  it("uses filesystem identity to retain a record across a rename", async () => {
    const source = join(directory, "before.mp3"); const destination = join(directory, "after.mp3");
    await writeFile(source, "not an audio stream");
    const library = database.addLibrary("Music", directory, directory);
    await scanner.scan(library);
    await waitFor(() => database.getLibrary(library.id)?.lastScannedAt != null);
    const original = database.queryTracks({ libraryId: library.id, search: "", group: "tracks", sortBy: "filename", sortDirection: "asc", offset: 0, limit: 20 }).items[0]!;
    await rename(source, destination);
    await scanner.scan(library);
    await waitFor(() => database.getTrack(original.id)?.absolutePath === destination);
    expect(database.queryTracks({ libraryId: library.id, search: "", group: "tracks", sortBy: "filename", sortDirection: "asc", offset: 0, limit: 20 })).toMatchObject({ total: 1, items: [{ id: original.id, filename: "after.mp3" }] });
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for scanner");
}
