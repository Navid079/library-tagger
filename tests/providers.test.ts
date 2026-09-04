import { describe, expect, it } from "vitest";
import { lyricConfidence, retryDelay } from "../src/main/providers";
import type { TrackDetails } from "../src/shared/models";

const track = {
  title: "The Song", artists: ["The Artist"], album: "The Album"
} as TrackDetails;

describe("provider behavior", () => {
  it("scores exact lyric metadata and duration above loose matches", () => {
    const exact = lyricConfidence(track, { trackName: "the song", artistName: "THE ARTIST", albumName: "The Album", duration: 201 }, 200);
    const loose = lyricConfidence(track, { trackName: "Other", artistName: "Someone", duration: 260 }, 200);
    expect(exact).toBe(1);
    expect(loose).toBeLessThan(exact);
  });

  it("honors numeric and HTTP-date Retry-After values within safe bounds", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryDelay("2", now)).toBe(2000);
    expect(retryDelay("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    expect(retryDelay("120", now)).toBe(30_000);
    expect(retryDelay(null, now)).toBe(1000);
  });
});
