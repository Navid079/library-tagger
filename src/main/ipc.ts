import { basename, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { channels } from "../shared/channels";
import { OrganizeRequestSchema, SettingsSchema, TagPatchSchema, TrackQuerySchema } from "../shared/models";
import { CatalogDatabase } from "./database";
import { JobManager } from "./jobs";
import { Organizer } from "./organizer";
import { ProviderService } from "./providers";
import { LibraryScanner } from "./scanner";
import { TagWriter } from "./tag-writer";

type Services = { catalog: CatalogDatabase; scanner: LibraryScanner; providers: ProviderService; organizer: Organizer; writer: TagWriter; jobs: JobManager };

export function registerIpc(window: BrowserWindow, services: Services): void {
  const handle = <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: TArgs) => {
      validateSender(event, window);
      return await listener(event, ...args);
    });
  };

  handle(channels.librariesList, () => services.catalog.listLibraries());
  handle(channels.librariesChoose, async () => {
    const selection = await dialog.showOpenDialog(window, { title: "Choose music libraries", properties: ["openDirectory", "multiSelections"] });
    if (selection.canceled) return services.catalog.listLibraries();
    for (const selectedPath of selection.filePaths) {
      if (!isAbsolute(selectedPath)) continue;
      const canonical = await realpath(selectedPath);
      if (services.catalog.findOverlappingLibrary(canonical)) continue;
      const library = services.catalog.addLibrary(basename(selectedPath) || selectedPath, selectedPath, canonical);
      await services.scanner.scan(library);
    }
    return services.catalog.listLibraries();
  });
  handle(channels.librariesRemove, async (_event, rawId: unknown) => {
    const id = z.number().int().parse(rawId); const library = services.catalog.getLibrary(id);
    if (!library) return false;
    const choice = await dialog.showMessageBox(window, { type: "question", buttons: ["Cancel", "Remove library"], defaultId: 0, cancelId: 0, title: "Remove library", message: `Remove “${library.name}” from Library Tagger?`, detail: "Music files will not be deleted or changed." });
    if (choice.response !== 1) return false;
    await services.scanner.unwatch(id); services.catalog.removeLibrary(id);
    return true;
  });
  handle(channels.librariesRescan, async (_event, rawId: unknown) => {
    const id = z.number().int().parse(rawId); const library = services.catalog.getLibrary(id);
    if (!library) throw new Error("Library not found"); return await services.scanner.scan(library);
  });
  handle(channels.tracksQuery, (_event, raw: unknown) => services.catalog.queryTracks(TrackQuerySchema.parse(raw)));
  handle(channels.tracksDetails, (_event, rawId: unknown) => {
    const track = services.catalog.getTrack(z.number().int().parse(rawId)); if (!track) throw new Error("Track not found"); return track;
  });
  handle(channels.tracksSave, async (_event, rawId: unknown, rawPatch: unknown) => {
    const id = z.number().int().parse(rawId); const patch = TagPatchSchema.parse(rawPatch);
    const track = services.catalog.getTrack(id); if (!track) throw new Error("Track not found");
    await services.writer.write(track, patch); await services.scanner.refreshTrack(id);
  });
  const withLookupJob = async (rawId: unknown, message: string, fn: (track: NonNullable<ReturnType<CatalogDatabase["getTrack"]>>, signal: AbortSignal) => Promise<unknown>) => {
    const track = services.catalog.getTrack(z.number().int().parse(rawId)); if (!track) throw new Error("Track not found");
    const job = services.jobs.create("lookup", `${message}: ${track.title ?? track.filename}`, 1);
    try {
      const result = await fn(track, job.signal);
      job.emit({ status: "completed", completed: 1, message: `${message} complete` });
      return result;
    } catch (error) {
      const cancelled = job.signal.aborted;
      job.emit({ status: cancelled ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), message: cancelled ? "Lookup cancelled" : `${message} failed` });
      if (cancelled) throw new Error("Lookup cancelled");
      throw error;
    }
  };
  handle(channels.lookupMetadata, (_event, id: unknown) => withLookupJob(id, "Metadata lookup", (track, signal) => services.providers.metadata(track, signal)));
  handle(channels.lookupLyrics, (_event, id: unknown) => withLookupJob(id, "Lyrics lookup", (track, signal) => services.providers.lyrics(track, signal)));
  handle(channels.lookupFingerprint, (_event, id: unknown) => withLookupJob(id, "Fingerprint lookup", (track, signal) => services.providers.fingerprint(track, signal)));
  handle(channels.lookupArtwork, (_event, rawUrl: unknown) => services.providers.downloadArtwork(z.string().url().parse(rawUrl)));
  handle(channels.organizePreview, (_event, raw: unknown) => services.organizer.preview(OrganizeRequestSchema.parse(raw)));
  handle(channels.organizeApply, (_event, rawId: unknown) => services.organizer.apply(z.string().uuid().parse(rawId)));
  handle(channels.organizeRecoverable, () => services.organizer.recoverable());
  handle(channels.organizeResume, (_event, rawId: unknown) => services.organizer.resume(z.string().uuid().parse(rawId)));
  handle(channels.organizeUndo, (_event, rawId: unknown) => services.organizer.undo(z.string().uuid().parse(rawId)));
  handle(channels.settingsGet, () => services.catalog.getSettings());
  handle(channels.settingsSet, (_event, raw: unknown) => services.catalog.setSettings(SettingsSchema.parse(raw)));
  handle(channels.jobsCancel, (_event, rawId: unknown) => services.jobs.cancel(z.string().uuid().parse(rawId)));
}

function validateSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Rejected IPC sender");
  const url = new URL(event.senderFrame.url);
  if (url.protocol !== "file:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Rejected IPC origin");
}
