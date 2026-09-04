import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, relative } from "node:path";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import type { OrganizePlan, OrganizeRequest } from "../shared/models";
import { CatalogDatabase } from "./database";
import { destinationFor, isPathInside } from "./path-template";
import type { PrivilegeAdapter } from "./privilege";

export class Organizer {
  private readonly plans = new Map<string, OrganizePlan>();

  constructor(private readonly catalog: CatalogDatabase, private readonly privilege: PrivilegeAdapter) {}

  async preview(request: OrganizeRequest): Promise<OrganizePlan> {
    const library = this.catalog.getLibrary(request.destinationLibraryId);
    if (!library) throw new Error("Destination library not found");
    const destinations = new Set<string>();
    const items: OrganizePlan["items"] = [];
    for (const trackId of request.trackIds) {
      const track = this.catalog.getTrack(trackId);
      if (!track) throw new Error(`Track ${trackId} not found`);
      let destinationPath = ""; let conflict: string | null = null;
      try {
        destinationPath = destinationFor(library.canonicalPath, request.template, track);
        if (!isPathInside(library.canonicalPath, destinationPath)) conflict = "Destination escapes the selected library";
        else if (destinationPath.length > 240) conflict = "Destination path exceeds the portable 240-character limit";
        else if (destinations.has(destinationPath)) conflict = "Another selected track has the same destination";
        else if (destinationPath !== track.absolutePath && await exists(destinationPath)) conflict = "A file already exists at the destination";
      } catch (error) { conflict = error instanceof Error ? error.message : String(error); }
      destinations.add(destinationPath);
      const sidecarSourcePath = track.sidecarLyrics == null ? null : track.absolutePath.slice(0, -extname(track.absolutePath).length) + ".lrc";
      const sidecarDestinationPath = sidecarSourcePath ? destinationPath.slice(0, -extname(destinationPath).length) + ".lrc" : null;
      if (!conflict && sidecarDestinationPath && sidecarSourcePath !== sidecarDestinationPath && await exists(sidecarDestinationPath)) conflict = "A lyrics sidecar already exists at the destination";
      let sourceHash = "0".repeat(64);
      try { sourceHash = await fileHash(track.absolutePath); }
      catch (error) { conflict ??= `Source is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
      items.push({ trackId, sourcePath: track.absolutePath, destinationPath, sidecarSourcePath, sidecarDestinationPath, sourceHash, conflict });
    }
    const plan: OrganizePlan = { id: randomUUID(), destinationLibraryId: library.id, items, canApply: items.every((item) => !item.conflict) };
    this.plans.set(plan.id, plan);
    return plan;
  }

  async apply(planId: string): Promise<string> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("Organization preview has expired");
    if (!plan.canApply) throw new Error("Resolve all conflicts before organizing");
    const library = this.catalog.getLibrary(plan.destinationLibraryId);
    if (!library) throw new Error("Destination library not found");
    const operationId = randomUUID();
    this.catalog.saveOperation(operationId, "organize", "running", plan);
    await this.continueOperation(operationId, plan, library.id, []);
    this.plans.delete(planId);
    return operationId;
  }

  recoverable(): ReturnType<CatalogDatabase["listRecoverableOperations"]> { return this.catalog.listRecoverableOperations(); }

  async resume(operationId: string): Promise<void> {
    const operation = this.catalog.getOperation(operationId);
    if (!operation || operation.kind !== "organize" || !["running", "failed"].includes(operation.status)) throw new Error("Recoverable organization operation not found");
    const plan = operation.payload as OrganizePlan;
    const library = this.catalog.getLibrary(plan.destinationLibraryId); if (!library) throw new Error("Destination library no longer exists");
    await this.continueOperation(operationId, plan, library.id, (operation.inverse ?? []) as InverseItem[]);
  }

  async undo(operationId: string): Promise<void> {
    const operation = this.catalog.getOperation(operationId);
    if (!operation || operation.kind !== "organize" || operation.status !== "completed") throw new Error("Completed organization operation not found");
    const items = operation.inverse as Array<{ trackId: number; from: string; to: string; sidecarFrom: string | null; sidecarTo: string | null; hash: string }>;
    const reversed = [...items].reverse();
    const libraries = this.catalog.listLibraries();
    for (const item of reversed) {
      if (!await exists(item.from) || await fileHash(item.from) !== item.hash) throw new Error(`Cannot undo because ${basename(item.from)} changed`);
      if (await exists(item.to)) throw new Error(`Cannot undo because ${item.to} already exists`);
      if (!libraries.some((candidate) => isPathInside(candidate.canonicalPath, item.to))) throw new Error("Original destination is no longer a registered library");
      if (item.sidecarFrom && item.sidecarTo && await exists(item.sidecarTo)) throw new Error(`Cannot undo because ${item.sidecarTo} already exists`);
    }
    for (const item of reversed) {
      await this.move(item.from, item.to, item.hash);
      if (item.sidecarFrom && item.sidecarTo && await exists(item.sidecarFrom)) await this.move(item.sidecarFrom, item.sidecarTo, await fileHash(item.sidecarFrom));
      const library = libraries.find((candidate) => isPathInside(candidate.canonicalPath, item.to))!;
      this.catalog.updateTrackPath(item.trackId, library.id, item.to, relative(library.canonicalPath, item.to), basename(item.to));
    }
    this.catalog.saveOperation(operationId, "organize", "undone", operation.payload, operation.inverse);
  }

  private async move(source: string, destination: string, hash: string): Promise<void> {
    const sourceStat = await stat(source);
    try { await safeMove(source, destination); }
    catch (error) {
      if (!isPermissionError(error)) throw error;
      await this.privilege.execute([{ action: "move", source, destination, expectedSourceHash: hash, mode: sourceStat.mode, ownerUid: sourceStat.uid, ownerGid: sourceStat.gid }], this.catalog.listLibraries().map((library) => library.canonicalPath));
    }
  }

  private async continueOperation(operationId: string, plan: OrganizePlan, destinationLibraryId: number, inverse: InverseItem[]): Promise<void> {
    const completed = new Set(inverse.map((item) => item.trackId));
    try {
      for (const item of plan.items) {
        if (completed.has(item.trackId) || item.sourcePath === item.destinationPath) continue;
        if (await exists(item.sourcePath)) {
          if (await fileHash(item.sourcePath) !== item.sourceHash) throw new Error(`Source changed after preview: ${basename(item.sourcePath)}`);
          await this.move(item.sourcePath, item.destinationPath, item.sourceHash);
        } else if (!await exists(item.destinationPath) || await fileHash(item.destinationPath) !== item.sourceHash) {
          throw new Error(`Cannot recover move for ${basename(item.sourcePath)}`);
        }
        if (item.sidecarSourcePath && item.sidecarDestinationPath && await exists(item.sidecarSourcePath)) await this.move(item.sidecarSourcePath, item.sidecarDestinationPath, await fileHash(item.sidecarSourcePath));
        const library = this.catalog.getLibrary(destinationLibraryId)!;
        this.catalog.updateTrackPath(item.trackId, library.id, item.destinationPath, relative(library.canonicalPath, item.destinationPath), basename(item.destinationPath));
        inverse.push({ trackId: item.trackId, from: item.destinationPath, to: item.sourcePath, sidecarFrom: item.sidecarDestinationPath, sidecarTo: item.sidecarSourcePath, hash: item.sourceHash });
        this.catalog.saveOperation(operationId, "organize", "running", plan, inverse);
      }
      this.catalog.saveOperation(operationId, "organize", "completed", plan, inverse);
    } catch (error) { this.catalog.saveOperation(operationId, "organize", "failed", plan, inverse); throw error; }
  }
}

type InverseItem = { trackId: number; from: string; to: string; sidecarFrom: string | null; sidecarTo: string | null; hash: string };

async function safeMove(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) throw new Error(`Destination already exists: ${destination}`);
  try { await rename(source, destination); return; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw error;
  }
  const temporary = `${destination}.library-tagger-${randomUUID()}.tmp`;
  let finalized = false;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    const [sourceStat, copiedStat] = await Promise.all([stat(source), stat(temporary)]);
    if (sourceStat.size !== copiedStat.size || await fileHash(source) !== await fileHash(temporary)) throw new Error("Cross-filesystem copy verification failed");
    await rename(temporary, destination);
    finalized = true;
    const destinationDirectory = await open(dirname(destination), "r");
    try { await destinationDirectory.sync(); } finally { await destinationDirectory.close(); }
    await unlink(source);
  } catch (error) {
    if (!finalized) await unlink(temporary).catch(() => undefined);
    else await unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function fileHash(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream()) hash.update(chunk);
  await handle.close().catch(() => undefined);
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> { return access(path).then(() => true, () => false); }
function isPermissionError(error: unknown): boolean { const code = (error as NodeJS.ErrnoException)?.code; return code === "EACCES" || code === "EPERM"; }
