import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseTag = process.env.RELEASE_TAG;
const expectedTag = `v${packageJson.version}`;

if (!releaseTag) {
  console.error("RELEASE_TAG is required");
  process.exit(1);
}

if (releaseTag !== expectedTag) {
  console.error(`Release tag ${releaseTag} does not match package version ${packageJson.version}; expected ${expectedTag}`);
  process.exit(1);
}

console.log(`Release identity verified: ${releaseTag}`);
