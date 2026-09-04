import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app, dialog, type BrowserWindow } from "electron";

export type PrivilegedOperation =
  | { action: "replace"; source: string; destination: string; expectedSourceHash: string; expectedDestinationHash: string | null; mode?: number; ownerUid?: number; ownerGid?: number }
  | { action: "move"; source: string; destination: string; expectedSourceHash: string; mode?: number; ownerUid?: number; ownerGid?: number }
  | { action: "mkdir"; destination: string };

export interface PrivilegeAdapter {
  available(): boolean;
  execute(operations: PrivilegedOperation[], allowedRoots: string[]): Promise<void>;
}

export class LinuxPolkitAdapter implements PrivilegeAdapter {
  constructor(private readonly window: BrowserWindow, private readonly manifestDirectory: string) {}

  available(): boolean { return process.platform === "linux" && existsSync("/usr/bin/pkexec") && existsSync(corePath()); }

  async execute(operations: PrivilegedOperation[], allowedRoots: string[]): Promise<void> {
    if (!this.available()) throw new Error("Polkit elevation is unavailable. Install the packaged Library Tagger helper or correct the folder permissions.");
    const choice = await dialog.showMessageBox(this.window, {
      type: "warning", buttons: ["Cancel", "Authenticate and continue"], defaultId: 0, cancelId: 0,
      title: "Administrator access required",
      message: "The selected files cannot be changed with your current permissions.",
      detail: operations.map((operation) => operation.action === "mkdir" ? operation.destination : operation.destination).join("\n")
    });
    if (choice.response !== 1) throw new Error("Privileged operation cancelled");
    const manifestPath = join(this.manifestDirectory, `privileged-${randomUUID()}.json`);
    await writeFile(manifestPath, JSON.stringify({ version: 1, operations, allowedRoots }), { mode: 0o600, flag: "wx" });
    try {
      await run("/usr/bin/pkexec", [corePath(), "privileged", manifestPath]);
    } finally { await unlink(manifestPath).catch(() => undefined); }
  }
}

export class UnsupportedPrivilegeAdapter implements PrivilegeAdapter {
  constructor(private readonly platformName: string) {}
  available(): boolean { return false; }
  async execute(): Promise<void> { throw new Error(`Administrator operations are not implemented by the ${this.platformName} adapter yet`); }
}

export class WindowsUacAdapter extends UnsupportedPrivilegeAdapter { constructor() { super("Windows UAC"); } }
export class MacAuthorizationAdapter extends UnsupportedPrivilegeAdapter { constructor() { super("macOS authorization helper"); } }

export function createPrivilegeAdapter(window: BrowserWindow, manifestDirectory: string): PrivilegeAdapter {
  if (process.platform === "linux") return new LinuxPolkitAdapter(window, manifestDirectory);
  if (process.platform === "win32") return new WindowsUacAdapter();
  return new MacAuthorizationAdapter();
}

export function corePath(): string {
  const name = process.platform === "win32" ? "library-tagger-core.exe" : "library-tagger-core";
  const electronApp = app as typeof app | undefined;
  const appPath = electronApp?.getAppPath?.() ?? process.cwd();
  const resourcesPath = process.resourcesPath ?? join(appPath, "resources");
  const candidates = electronApp?.isPackaged
    ? [join("/usr/lib/library-tagger", name), join(resourcesPath, "bin", name)]
    : [join(appPath, "native", "target", "release", name), join(appPath, "native", "target", "debug", name), join(resourcesPath, "bin", name)];
  return candidates.find(existsSync) ?? candidates[0]!;
}

export async function sha256(path: string): Promise<string> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r"); const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream()) hash.update(chunk);
  await handle.close().catch(() => undefined);
  return hash.digest("hex");
}

export async function run(program: string, args: string[], stdin?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${program} exited with ${code}`)));
    child.stdin.end(stdin);
  });
}
