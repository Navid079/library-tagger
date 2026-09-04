import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { TagPatch, TrackDetails } from "../shared/models";
import { corePath, type PrivilegedOperation, type PrivilegeAdapter, run, sha256 } from "./privilege";

export class TagWriter {
  constructor(private readonly privilege: PrivilegeAdapter, private readonly stagingDirectory: string, private readonly libraryRoots: () => string[], private readonly coverCache?: string) {}

  async write(track: TrackDetails, patch: TagPatch): Promise<void> {
    if (!track.writable) throw new Error(`${track.format.toUpperCase()} files are read-only in this version`);
    const sourceStat = await stat(track.absolutePath);
    if (sourceStat.size !== patch.expectedSize || Math.abs(sourceStat.mtimeMs - patch.expectedModifiedMs) > 2) throw new Error("The file changed outside Library Tagger. Rescan before saving.");
    const extension = extname(track.absolutePath);
    const normalTemporary = join(dirname(track.absolutePath), `.library-tagger-${randomUUID()}${extension}`);
    try {
      await this.prepareTaggedCopy(track, normalTemporary, patch, sourceStat.mode, { uid: sourceStat.uid, gid: sourceStat.gid });
      await rename(normalTemporary, track.absolutePath);
      await this.writeSidecars(track, patch, false);
    } catch (error) {
      await unlink(normalTemporary).catch(() => undefined);
      if (!isPermissionError(error)) throw error;
      await mkdir(this.stagingDirectory, { recursive: true });
      const staged = join(this.stagingDirectory, `${randomUUID()}${extension}`);
      await this.prepareTaggedCopy(track, staged, patch, sourceStat.mode);
      const ownership = { mode: sourceStat.mode, ownerUid: sourceStat.uid, ownerGid: sourceStat.gid };
      const operations: PrivilegedOperation[] = [{ action: "replace", source: staged, destination: track.absolutePath, expectedSourceHash: await sha256(staged), expectedDestinationHash: await existingHash(track.absolutePath), ...ownership }];
      if (patch.sidecarLyrics !== undefined) {
        const sidecarPath = track.absolutePath.slice(0, -extension.length) + ".lrc";
        const sidecarStage = join(this.stagingDirectory, `${randomUUID()}.lrc`);
        await writeFile(sidecarStage, patch.sidecarLyrics ?? "", { mode: 0o644 });
        operations.push({ action: "replace", source: sidecarStage, destination: sidecarPath, expectedSourceHash: await sha256(sidecarStage), expectedDestinationHash: await existingHash(sidecarPath) });
      }
      if (patch.writeFolderCover && patch.cover) {
        const artStage = join(this.stagingDirectory, `${randomUUID()}.jpg`);
        await writeFile(artStage, Buffer.from(patch.cover.dataBase64, "base64"), { mode: 0o644 });
        const destination = join(dirname(track.absolutePath), "folder.jpg");
        operations.push({ action: "replace", source: artStage, destination, expectedSourceHash: await sha256(artStage), expectedDestinationHash: await existingHash(destination) });
      }
      await this.privilege.execute(operations, this.libraryRoots());
    }
  }

  private async prepareTaggedCopy(track: TrackDetails, temporary: string, patch: TagPatch, mode: number, ownership?: { uid: number; gid: number }): Promise<void> {
    await copyFile(track.absolutePath, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, mode);
    if (ownership && process.platform !== "win32") await chown(temporary, ownership.uid, ownership.gid);
    try {
      await run(corePath(), ["write"], JSON.stringify({ path: temporary, patch, recoveryPatch: await this.recoveryPatch(track, patch) }));
      const result = await stat(temporary);
      if (!result.isFile() || result.size === 0) throw new Error("Tag writer produced an invalid file");
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }

  private async recoveryPatch(track: TrackDetails, patch: TagPatch): Promise<TagPatch> {
    const identifiers = { ...track.identifiers, ...patch.identifiers };
    for (const key of patch.removedIdentifiers ?? []) delete identifiers[key];
    const removedAdvanced = new Set(patch.removedAdvancedTags ?? []);
    const advancedTags = (patch.advancedTags ?? track.advancedTags).filter((item) => !removedAdvanced.has(item.key));
    let cover = patch.cover;
    if (cover === undefined && track.coverUrl && this.coverCache) {
      const hash = track.coverUrl.replace("media://cover/", "");
      if (/^[a-f0-9]{64}$/.test(hash)) {
        const data = await readFile(join(this.coverCache, hash)).catch(() => null);
        if (data) cover = { mimeType: data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : "image/jpeg", dataBase64: data.toString("base64") };
      }
    }
    return {
      title: patch.title !== undefined ? patch.title : track.title,
      artists: patch.artists ?? track.artists,
      albumArtists: patch.albumArtists ?? track.albumArtists,
      album: patch.album !== undefined ? patch.album : track.album,
      trackNumber: patch.trackNumber !== undefined ? patch.trackNumber : track.trackNumber,
      trackTotal: patch.trackTotal !== undefined ? patch.trackTotal : track.trackTotal,
      discNumber: patch.discNumber !== undefined ? patch.discNumber : track.discNumber,
      discTotal: patch.discTotal !== undefined ? patch.discTotal : track.discTotal,
      date: patch.date !== undefined ? patch.date : validDate(track.date),
      genres: patch.genres ?? track.genres,
      composers: patch.composers ?? track.composers,
      comment: patch.comment !== undefined ? patch.comment : track.comment,
      embeddedLyrics: patch.embeddedLyrics !== undefined ? patch.embeddedLyrics : track.embeddedLyrics,
      identifiers,
      advancedTags,
      cover,
      expectedSize: patch.expectedSize,
      expectedModifiedMs: patch.expectedModifiedMs
    };
  }

  private async writeSidecars(track: TrackDetails, patch: TagPatch, _privileged: boolean): Promise<void> {
    if (patch.sidecarLyrics !== undefined) {
      const destination = track.absolutePath.slice(0, -extname(track.absolutePath).length) + ".lrc";
      await atomicWrite(destination, patch.sidecarLyrics ?? "");
    }
    if (patch.writeFolderCover && patch.cover) {
      const destination = join(dirname(track.absolutePath), "folder.jpg");
      await atomicWrite(destination, Buffer.from(patch.cover.dataBase64, "base64"));
    }
  }
}

async function atomicWrite(destination: string, data: string | Buffer): Promise<void> {
  const temporary = `${destination}.library-tagger-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function existingHash(path: string): Promise<string | null> {
  try { return await sha256(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && ("code" in error && ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM"));
}

function validDate(value: string | null): string | null {
  if (!value) return null;
  return /^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:T\d{2}(?::\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) ? value : null;
}
