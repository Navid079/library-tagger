import { describe, expect, it } from "vitest";
import { OrganizeRequestSchema, TagPatchSchema, TrackQuerySchema } from "../src/shared/models";

describe("IPC request schemas", () => {
  it("sets bounded query defaults", () => expect(TrackQuerySchema.parse({})).toMatchObject({ limit: 250, offset: 0, sortBy: "title" }));
  it("rejects pathless organization and oversized queries", () => { expect(() => OrganizeRequestSchema.parse({ trackIds: [], destinationLibraryId: 1, template: "x" })).toThrow(); expect(() => TrackQuerySchema.parse({ limit: 1001 })).toThrow(); });
  it("requires stale-write guards", () => expect(() => TagPatchSchema.parse({ title: "x" })).toThrow());
});
