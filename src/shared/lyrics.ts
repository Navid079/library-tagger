import type { LyricsState } from "./models";

const timestamp = /^\s*\[(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.:]\d{1,3})?]/m;
export function lyricsState(embedded: string | null | undefined, sidecar: string | null | undefined): LyricsState {
  return { embedded: Boolean(embedded?.trim()), sidecar: Boolean(sidecar?.trim()), synchronized: Boolean(sidecar && timestamp.test(sidecar)), instrumental: false };
}
