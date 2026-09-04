import type { LibraryTaggerApi } from "../shared/models";

declare global { interface Window { libraryTagger: LibraryTaggerApi; } }
export {};
