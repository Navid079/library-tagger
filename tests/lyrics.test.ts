import { describe, expect, it } from "vitest";
import { lyricsState } from "../src/shared/lyrics";

describe("lyrics state", () => {
  it("distinguishes embedded, sidecar, and synchronized lyrics", () => {
    expect(lyricsState("words", null)).toMatchObject({ embedded: true, sidecar: false, synchronized: false });
    expect(lyricsState(null, "[01:23.45]words")).toMatchObject({ embedded: false, sidecar: true, synchronized: true });
  });
  it("does not count blank content", () => expect(lyricsState("  ", "\n")).toMatchObject({ embedded: false, sidecar: false }));
});
