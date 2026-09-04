import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { app, BrowserWindow, protocol } from "electron";
import { CatalogDatabase } from "./database";
import { registerIpc } from "./ipc";
import { JobManager } from "./jobs";
import { Organizer } from "./organizer";
import { createPrivilegeAdapter } from "./privilege";
import { ProviderService } from "./providers";
import { LibraryScanner } from "./scanner";
import { TagWriter } from "./tag-writer";

protocol.registerSchemesAsPrivileged([{ scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);

let catalog: CatalogDatabase | undefined;
let scanner: LibraryScanner | undefined;

async function createWindow(): Promise<void> {
  if (scanner) await scanner.close();
  catalog?.close();
  const window = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1040, minHeight: 680, show: false,
    backgroundColor: "#f8fafc",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const userData = app.getPath("userData");
  const coverCache = join(userData, "cover-cache"); const staging = join(userData, "staging");
  await Promise.all([mkdir(coverCache, { recursive: true }), mkdir(staging, { recursive: true })]);
  catalog = new CatalogDatabase(join(userData, "library.sqlite"));
  const jobs = new JobManager(); jobs.attach(window);
  scanner = new LibraryScanner(catalog, coverCache, jobs);
  const providers = new ProviderService(catalog);
  const privilege = createPrivilegeAdapter(window, staging);
  const organizer = new Organizer(catalog, privilege);
  const writer = new TagWriter(privilege, staging, () => catalog!.listLibraries().map((library) => library.canonicalPath), coverCache);
  registerIpc(window, { catalog, scanner, providers, organizer, writer, jobs });

  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
  for (const library of catalog.listLibraries()) void scanner.scan(library);
}

app.whenReady().then(async () => {
  const coverCache = join(app.getPath("userData"), "cover-cache");
  protocol.handle("media", async (request) => {
    const url = new URL(request.url); const hash = url.pathname.replace(/^\//, "");
    if (url.hostname !== "cover" || !/^[a-f0-9]{64}$/.test(hash)) return new Response("Not found", { status: 404 });
    try { const bytes = await readFile(join(coverCache, hash)); const contentType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : "image/jpeg"; return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=31536000, immutable" } }); }
    catch { return new Response("Not found", { status: 404 }); }
  });
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void scanner?.close(); catalog?.close(); });
