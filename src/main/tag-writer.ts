import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, copyFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { TagPatch, TrackDetails } from "../shared/models";
import { corePath, type PrivilegedOperation, type PrivilegeAdapter, run, sha256 } from "./privilege";

export class TagWriter {
  constructor(private readonly privilege: PrivilegeAdapter, private readonly stagingDirectory: string, private readonly libraryRoots: () => string[]) {}

  async write(track: TrackDetails, patch: TagPatch): Promise<void> {
    if (!track.writable) throw new Error(`${track.format.toUpperCase()} files are read-only in this version`);
    const sourceStat = await stat(track.absolutePath);
    if (sourceStat.size !== patch.expectedSize || Math.abs(sourceStat.mtimeMs - patch.expectedModifiedMs) > 2) throw new Error("The file changed outside Library Tagger. Rescan before saving.");
    const extension = extname(track.absolutePath);
    const normalTemporary = join(dirname(track.absolutePath), `.library-tagger-${randomUUID()}${extension}`);
    try {
      await this.prepareTaggedCopy(track.absolutePath, normalTemporary, patch, sourceStat.mode, { uid: sourceStat.uid, gid: sourceStat.gid });
      await rename(normalTemporary, track.absolutePath);
      await this.writeSidecars(track, patch, false);
    } catch (error) {
      await unlink(normalTemporary).catch(() => undefined);
      if (!isPermissionError(error)) throw error;
      await mkdir(this.stagingDirectory, { recursive: true });
      const staged = join(this.stagingDirectory, `${randomUUID()}${extension}`);
      await this.prepareTaggedCopy(track.absolutePath, staged, patch, sourceStat.mode);
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

  private async prepareTaggedCopy(source: string, temporary: string, patch: TagPatch, mode: number, ownership?: { uid: number; gid: number }): Promise<void> {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, mode);
    if (ownership && process.platform !== "win32") await chown(temporary, ownership.uid, ownership.gid);
    try {
      await run(corePath(), ["write"], JSON.stringify({ path: temporary, patch }));
      const result = await stat(temporary);
      if (!result.isFile() || result.size === 0) throw new Error("Tag writer produced an invalid file");
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
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
