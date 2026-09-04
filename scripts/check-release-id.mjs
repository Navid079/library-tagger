import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
const policy = await readFile(new URL("../packaging/io.github.navid079.library-tagger.policy", import.meta.url), "utf8");
const applicationId = "io.github.navid079.library-tagger";
if (!config.includes(`appId: ${applicationId}`) || !policy.includes(`<action id="${applicationId}.modify-protected-library">`) || !packageJson.includes("https://github.com/Navid079/library-tagger")) {
  console.error("Packaging blocked: the application ID, Polkit action, and GitHub publisher identity are inconsistent.");
  process.exit(1);
}
