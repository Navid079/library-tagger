# Library Tagger

Library Tagger is a private Electron desktop application for indexing, editing, identifying, and organizing local music libraries. The first packaged target is x86-64 Linux; filesystem, fingerprinting, and privilege boundaries are designed for later Windows and macOS adapters.

Linux packages are available from [GitHub Releases](https://github.com/Navid079/library-tagger/releases).

## Features

- Multiple watched library roots with recursive, non-symlink indexing, incremental identity-based rescans, corrupt-file error rows, and offline-library retention.
- Virtualized track browser with filename/metadata search, artist/album grouping, and lyric/cover/write-state badges.
- Atomic editing for MP3, FLAC, M4A/AAC, Ogg Vorbis, and Opus. Other recognized formats are indexed read-only.
- Common and batch tags, editable identifiers, format-supported advanced text tags, embedded covers, embedded lyrics, synchronized `.lrc` sidecars, and optional `folder.jpg`.
- Review-first, cancellable MusicBrainz, Cover Art Archive, LRCLIB, and AcoustID suggestions.
- A bundled pure-Rust Chromaprint-compatible fingerprinter—no system `fpcalc` dependency.
- Portable organization templates, previewed conflicts, hash-verified cross-filesystem moves, operation journals, and guarded undo.
- A sandboxed renderer and narrow, Zod-validated IPC API. The UI never receives Node, filesystem, shell, or generic IPC access.
- On-demand Linux Polkit helper for an exact validated operation; the Electron application itself is never elevated.

## Development

Requirements: Node.js 24+, npm 11+, stable Rust, and FFmpeg for real-format integration tests.

```bash
npm install
cargo build --manifest-path native/Cargo.toml
npm run dev
```

If the development environment exports `ELECTRON_RUN_AS_NODE`, unset it when launching Electron:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

Commands:

- `npm run typecheck` — strict main, preload, shared-contract, and renderer checks.
- `npm run lint` — static lint checks for application, native-boundary tests, and build scripts.
- `npm test` — unit and catalog tests.
- `cargo test --manifest-path native/Cargo.toml` — native helper validation tests.
- `npm run test:integration` — generates six real audio formats, round-trips tags/lyrics/artwork, fingerprints audio, and scans the resulting library.
- `npm run test:e2e` — builds and launches Electron, verifies the renderer, and exercises the Settings dialog over Chromium's debugging protocol.
- `npm run build` — production Electron bundles.
- `npm run package:linux` — x86-64 `.deb` and `.rpm` packages.
- `npm run package:linux:test` — CI-only package build using a local test app ID while the permanent publisher ID is unresolved.

The source-owned React Aria primitives adapt the free Untitled UI React patterns. Its MIT license is retained in `THIRD_PARTY_NOTICES.md` and included in packages.

## Provider configuration and privacy

Set a meaningful contact/project string and private AcoustID application key in Settings. `ACOUSTID_CLIENT_KEY` can override the saved key during development. Library Tagger sends track metadata or fingerprints only after the user explicitly starts a lookup. It does not submit tags, fingerprints, or lyrics to providers.

MusicBrainz calls are serialized to at most one per second, LRCLIB calls are serialized and honor `Retry-After`, and AcoustID calls remain below three requests per second. Suggestions show their source and confidence and only stage user-selected fields; Save is still required.

## Packaging identity

The permanent application ID is `io.github.navid079.library-tagger`, based on the GitHub publisher identity `Navid079`. Run `npm run package:linux` and test installation/removal in clean Debian- and RPM-family virtual machines before publishing a release.

Installed packages place the constrained helper in `/usr/lib/library-tagger/` and its action in `/usr/share/polkit-1/actions/`. Polkit—not Library Tagger—collects administrator credentials. Authorization is not retained.

## Safety model

Tag saves verify the indexed size and modification timestamp, write a separate same-filesystem copy, validate it, and atomically replace the original. Organization refuses collisions and paths outside registered roots. Cross-filesystem moves copy, fsync, compare SHA-256, finalize, then remove the source. Privileged manifests accept only fixed file operations and revalidate regular files, hashes, roots, and symbolic links inside the native helper.

Empty directories are never automatically deleted. Removing a library removes only its catalog records and watcher; it never deletes music files.
