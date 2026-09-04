import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../shared/channels";
import type { JobEvent, LibraryTaggerApi } from "../shared/models";

const api: LibraryTaggerApi = {
  libraries: {
    list: () => ipcRenderer.invoke(channels.librariesList),
    chooseAndAdd: () => ipcRenderer.invoke(channels.librariesChoose),
    remove: (id) => ipcRenderer.invoke(channels.librariesRemove, id),
    rescan: (id) => ipcRenderer.invoke(channels.librariesRescan, id)
  },
  tracks: {
    query: (query) => ipcRenderer.invoke(channels.tracksQuery, query),
    details: (id) => ipcRenderer.invoke(channels.tracksDetails, id),
    save: (id, patch) => ipcRenderer.invoke(channels.tracksSave, id, patch)
  },
  lookup: {
    metadata: (id) => ipcRenderer.invoke(channels.lookupMetadata, id),
    lyrics: (id) => ipcRenderer.invoke(channels.lookupLyrics, id),
    fingerprint: (id) => ipcRenderer.invoke(channels.lookupFingerprint, id),
    downloadArtwork: (url) => ipcRenderer.invoke(channels.lookupArtwork, url)
  },
  organize: {
    preview: (request) => ipcRenderer.invoke(channels.organizePreview, request),
    apply: (id) => ipcRenderer.invoke(channels.organizeApply, id),
    recoverable: () => ipcRenderer.invoke(channels.organizeRecoverable),
    resume: (id) => ipcRenderer.invoke(channels.organizeResume, id),
    undo: (id) => ipcRenderer.invoke(channels.organizeUndo, id)
  },
  settings: { get: () => ipcRenderer.invoke(channels.settingsGet), set: (settings) => ipcRenderer.invoke(channels.settingsSet, settings) },
  jobs: {
    cancel: (id) => ipcRenderer.invoke(channels.jobsCancel, id),
    subscribe: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: JobEvent): void => callback(payload);
      ipcRenderer.on(channels.jobsEvent, listener);
      return () => ipcRenderer.removeListener(channels.jobsEvent, listener);
    }
  }
};

contextBridge.exposeInMainWorld("libraryTagger", api);
