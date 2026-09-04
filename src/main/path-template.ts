import { extname, join } from "node:path";
import type { TrackDetails } from "../shared/models";

const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeSegment(input: string, fallback: string): string {
  // oxlint-disable-next-line no-control-regex -- Windows forbids ASCII control characters in path segments.
  let value = input.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!value || value === "." || value === "..") value = fallback;
  if (windowsReserved.test(value)) value = `_${value}`;
  return [...value].slice(0, 120).join("");
}

export function expandOrganizationTemplate(template: string, track: TrackDetails): string {
  const extension = extname(track.filename).slice(1).toLowerCase();
  const albumArtist = track.albumArtists[0] ?? track.artists[0] ?? "Unknown Artist";
  const values: Record<string, string> = {
    albumArtist: sanitizeSegment(albumArtist, "Unknown Artist"),
    artist: sanitizeSegment(track.artists[0] ?? "Unknown Artist", "Unknown Artist"),
    album: sanitizeSegment(track.album ?? "Unknown Album", "Unknown Album"),
    title: sanitizeSegment(track.title ?? `Untitled ${track.id}`, `Untitled ${track.id}`),
    track: track.trackNumber ? String(track.trackNumber) : "00",
    disc: track.discNumber ? String(track.discNumber) : "1",
    discFolder: track.discTotal && track.discTotal > 1 ? `Disc ${track.discNumber ?? 1}/` : "",
    ext: extension
  };
  const expanded = template.replace(/\{([a-zA-Z]+)(?::(\d+))?}/g, (_match, key: string, width?: string) => {
    const value = values[key];
    if (value == null) throw new Error(`Unknown organization token: ${key}`);
    return width ? value.padStart(Number(width), "0") : value;
  });
  if (expanded.includes("{") || expanded.includes("}")) throw new Error("Invalid organization template");
  return expanded.split(/[\\/]+/).filter(Boolean).map((part) => sanitizeSegment(part, "Unknown")).join("/");
}

export function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return target === root || target.startsWith(normalizedRoot);
}

export function destinationFor(root: string, template: string, track: TrackDetails): string {
  return join(root, ...expandOrganizationTemplate(template, track).split("/"));
}
