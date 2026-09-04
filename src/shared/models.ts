import { z } from "zod";

export const editableExtensions = ["mp3", "flac", "m4a", "aac", "ogg", "opus"] as const;

export const LibrarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  rootPath: z.string(),
  canonicalPath: z.string(),
  online: z.boolean(),
  trackCount: z.number().int(),
  lastScannedAt: z.string().nullable()
});
export type Library = z.infer<typeof LibrarySchema>;

export const LyricsStateSchema = z.object({
  embedded: z.boolean(),
  sidecar: z.boolean(),
  synchronized: z.boolean(),
  instrumental: z.boolean().default(false)
});
export type LyricsState = z.infer<typeof LyricsStateSchema>;

export const TrackSummarySchema = z.object({
  id: z.number().int(),
  libraryId: z.number().int(),
  filename: z.string(),
  relativePath: z.string(),
  absolutePath: z.string(),
  title: z.string().nullable(),
  artists: z.array(z.string()),
  albumArtist: z.string().nullable(),
  album: z.string().nullable(),
  trackNumber: z.number().int().nullable(),
  discNumber: z.number().int().nullable(),
  year: z.number().int().nullable(),
  durationMs: z.number().nullable(),
  format: z.string(),
  writable: z.boolean(),
  hasCover: z.boolean(),
  coverUrl: z.string().nullable(),
  lyrics: LyricsStateSchema,
  available: z.boolean(),
  error: z.string().nullable(),
  size: z.number(),
  modifiedMs: z.number()
});
export type TrackSummary = z.infer<typeof TrackSummarySchema>;

export const AdvancedTextTagSchema = z.object({ key: z.string().min(1), value: z.string() });
export type AdvancedTextTag = z.infer<typeof AdvancedTextTagSchema>;

export const TrackDetailsSchema = TrackSummarySchema.extend({
  albumArtists: z.array(z.string()),
  trackTotal: z.number().int().nullable(),
  discTotal: z.number().int().nullable(),
  date: z.string().nullable(),
  genres: z.array(z.string()),
  composers: z.array(z.string()),
  comment: z.string().nullable(),
  identifiers: z.record(z.string(), z.string()),
  embeddedLyrics: z.string().nullable(),
  sidecarLyrics: z.string().nullable(),
  advancedTags: z.array(AdvancedTextTagSchema)
});
export type TrackDetails = z.infer<typeof TrackDetailsSchema>;

export const TagPatchSchema = z.object({
  title: z.string().nullable().optional(),
  artists: z.array(z.string()).optional(),
  albumArtists: z.array(z.string()).optional(),
  album: z.string().nullable().optional(),
  trackNumber: z.number().int().positive().nullable().optional(),
  trackTotal: z.number().int().positive().nullable().optional(),
  discNumber: z.number().int().positive().nullable().optional(),
  discTotal: z.number().int().positive().nullable().optional(),
  date: z.string().nullable().optional(),
  genres: z.array(z.string()).optional(),
  composers: z.array(z.string()).optional(),
  comment: z.string().nullable().optional(),
  identifiers: z.record(z.string(), z.string()).optional(),
  removedIdentifiers: z.array(z.string()).optional(),
  embeddedLyrics: z.string().nullable().optional(),
  sidecarLyrics: z.string().nullable().optional(),
  advancedTags: z.array(AdvancedTextTagSchema).optional(),
  removedAdvancedTags: z.array(z.string()).optional(),
  cover: z.object({ mimeType: z.enum(["image/jpeg", "image/png"]), dataBase64: z.string() }).nullable().optional(),
  writeFolderCover: z.boolean().optional(),
  expectedSize: z.number().nonnegative(),
  expectedModifiedMs: z.number().nonnegative()
});
export type TagPatch = z.infer<typeof TagPatchSchema>;

export const TrackQuerySchema = z.object({
  libraryId: z.number().int().optional(),
  search: z.string().max(500).default(""),
  group: z.enum(["tracks", "artists", "albums"]).default("tracks"),
  sortBy: z.enum(["filename", "title", "artist", "album", "year", "trackNumber", "format", "path"]).default("title"),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(1000).default(250)
});
export type TrackQuery = z.infer<typeof TrackQuerySchema>;

export const ProviderCandidateSchema = z.object({
  id: z.string(),
  source: z.enum(["musicbrainz", "cover-art-archive", "lrclib", "acoustid"]),
  confidence: z.number().min(0).max(1),
  attribution: z.string(),
  title: z.string().optional(),
  artists: z.array(z.string()).optional(),
  album: z.string().optional(),
  albumArtist: z.string().optional(),
  date: z.string().optional(),
  trackNumber: z.number().int().optional(),
  identifiers: z.record(z.string(), z.string()).optional(),
  plainLyrics: z.string().nullable().optional(),
  syncedLyrics: z.string().nullable().optional(),
  coverUrl: z.string().url().optional()
});
export type ProviderCandidate = z.infer<typeof ProviderCandidateSchema>;

export const OrganizeRequestSchema = z.object({
  trackIds: z.array(z.number().int()).min(1),
  destinationLibraryId: z.number().int(),
  template: z.string().min(1).max(500).default("{albumArtist}/{album}/{discFolder}{track:02} - {title}.{ext}")
});
export type OrganizeRequest = z.infer<typeof OrganizeRequestSchema>;

export const OrganizeItemSchema = z.object({
  trackId: z.number().int(),
  sourcePath: z.string(),
  destinationPath: z.string(),
  sidecarSourcePath: z.string().nullable(),
  sidecarDestinationPath: z.string().nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  conflict: z.string().nullable()
});
export const OrganizePlanSchema = z.object({
  id: z.string(),
  destinationLibraryId: z.number().int(),
  items: z.array(OrganizeItemSchema),
  canApply: z.boolean()
});
export type OrganizePlan = z.infer<typeof OrganizePlanSchema>;
export type RecoverableOperation = { id: string; completed: number; total: number; status: "running" | "failed" };

export const SettingsSchema = z.object({
  providerContact: z.string().default("private desktop app"),
  acoustIdKey: z.string().default(""),
  organizationTemplate: z.string().default("{albumArtist}/{album}/{discFolder}{track:02} - {title}.{ext}")
});
export type Settings = z.infer<typeof SettingsSchema>;

export const JobEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["scan", "write", "lookup", "organize"]),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  message: z.string(),
  error: z.string().optional()
});
export type JobEvent = z.infer<typeof JobEventSchema>;

export type TrackPage = { items: TrackSummary[]; total: number };

export interface LibraryTaggerApi {
  libraries: {
    list(): Promise<Library[]>;
    chooseAndAdd(): Promise<Library[]>;
    remove(id: number): Promise<boolean>;
    rescan(id: number): Promise<string>;
  };
  tracks: {
    query(query: Partial<TrackQuery>): Promise<TrackPage>;
    details(id: number): Promise<TrackDetails>;
    save(id: number, patch: TagPatch): Promise<void>;
  };
  lookup: {
    metadata(trackId: number): Promise<ProviderCandidate[]>;
    lyrics(trackId: number): Promise<ProviderCandidate[]>;
    fingerprint(trackId: number): Promise<ProviderCandidate[]>;
    downloadArtwork(url: string): Promise<{ mimeType: "image/jpeg" | "image/png"; dataBase64: string }>;
  };
  organize: {
    preview(request: OrganizeRequest): Promise<OrganizePlan>;
    apply(planId: string): Promise<string>;
    recoverable(): Promise<RecoverableOperation[]>;
    resume(operationId: string): Promise<void>;
    undo(operationId: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(settings: Settings): Promise<Settings>;
  };
  jobs: {
    cancel(id: string): Promise<void>;
    subscribe(callback: (event: JobEvent) => void): () => void;
  };
}
