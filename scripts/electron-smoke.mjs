import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = process.cwd();
const executable = join(project, "node_modules", "electron", "dist", "electron");
const profile = await mkdtemp(join(tmpdir(), "library-tagger-e2e-"));
const port = await freePort();
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(executable, [project, "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  cwd: project,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"]
});
let diagnostics = "";
child.stdout.on("data", (chunk) => { diagnostics += chunk; });
child.stderr.on("data", (chunk) => { diagnostics += chunk; });

try {
  const page = await waitForPage(port);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await waitFor(async () => Boolean(await cdp.evaluate("document.body?.innerText.includes('Library Tagger')")), "main renderer");
  const clicked = await cdp.evaluate("(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Settings'); button?.click(); return Boolean(button); })()");
  if (!clicked) throw new Error("Settings button was not found");
  await waitFor(async () => Boolean(await cdp.evaluate("document.querySelector('[role=dialog]')?.textContent?.includes('Settings')")), "Settings dialog");
  console.log("Electron smoke test passed: renderer loaded and Settings dialog opened.");
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
} finally {
  if (child.exitCode == null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode == null) child.kill("SIGKILL");
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a debugging port");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForPage(port) {
  let lastError;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError ?? new Error("Electron debugging endpoint did not appear");
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    call,
    async evaluate(expression) {
      const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Renderer evaluation failed");
      return result.result.value;
    }
  };
}

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
