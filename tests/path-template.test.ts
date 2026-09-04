import { describe, expect, it } from "vitest";
import { expandOrganizationTemplate, isPathInside, sanitizeSegment } from "../src/main/path-template";
import type { TrackDetails } from "../src/shared/models";

const track: TrackDetails = {
  id: 7, libraryId: 1, filename: "source.mp3", relativePath: "source.mp3", absolutePath: "/music/source.mp3",
  title: "A: Song?", artists: ["Artist"], albumArtist: "Album Artist", albumArtists: ["Album Artist"], album: "CON",
  trackNumber: 3, trackTotal: 10, discNumber: 2, discTotal: 2, date: "2025", year: 2025, genres: [], composers: [],
  comment: null, identifiers: {}, embeddedLyrics: null, sidecarLyrics: null, advancedTags: [], durationMs: 1000,
  format: "mp3", writable: true, hasCover: false, coverUrl: null, lyrics: { embedded: false, sidecar: false, synchronized: false, instrumental: false },
  available: true, error: null, size: 100, modifiedMs: 50
};

describe("portable organization paths", () => {
  it("expands tokens and applies Windows-safe names on Linux", () => expect(expandOrganizationTemplate("{albumArtist}/{album}/{discFolder}{track:02} - {title}.{ext}", track)).toBe("Album Artist/_CON/Disc 2/03 - A_ Song_.mp3"));
  it("handles reserved and empty segments", () => { expect(sanitizeSegment("NUL", "fallback")).toBe("_NUL"); expect(sanitizeSegment("...", "fallback")).toBe("fallback"); });
  it("checks library containment without prefix confusion", () => { expect(isPathInside("/music", "/music/album/a.mp3")).toBe(true); expect(isPathInside("/music", "/music-old/a.mp3")).toBe(false); });
  it("rejects unknown tokens", () => expect(() => expandOrganizationTemplate("{artist}/{unknown}.{ext}", track)).toThrow("Unknown organization token"));
});
