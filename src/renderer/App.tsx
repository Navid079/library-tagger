import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MusicNote01 } from "@untitledui/icons";
import { FaCompactDisc } from "react-icons/fa";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  FileAudio,
  Fingerprint,
  FolderCog,
  FolderPlus,
  Image as ImageIcon,
  ImagePlus,
  Library,
  ListMusic,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon,
  SkipBack,
  SkipForward,
  Sparkles,
  Tags,
  Trash2,
  Undo2,
  Volume2,
  X,
} from "lucide-react";
import type {
  JobEvent,
  Library as LibraryModel,
  OrganizePlan,
  ProviderCandidate,
  RecoverableOperation,
  Settings,
  TagPatch,
  TrackDetails,
  TrackQuery,
  TrackSummary,
} from "../shared/models";
import { AppModal, Badge, Button, Field } from "./components/ui";
import { cn } from "./lib/cn";

const api = window.libraryTagger;

export function App(): ReactNode {
  const [libraries, setLibraries] = useState<LibraryModel[]>([]);
  const [libraryId, setLibraryId] = useState<number | undefined>();
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<TrackQuery["group"]>("tracks");
  const [sortBy, setSortBy] = useState<TrackQuery["sortBy"]>("title");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [activeId, setActiveId] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Map<string, JobEvent>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [recoverable, setRecoverable] = useState<RecoverableOperation[]>([]);
  const [lastOperationId, setLastOperationId] = useState<string | null>(null);
  const [playerRequest, setPlayerRequest] = useState<{ id: number; nonce: number } | null>(null);

  const refreshLibraries = useCallback(
    async () => setLibraries(await api.libraries.list()),
    [],
  );
  const loadTracks = useCallback(
    async (append = false) => {
      setLoading(true);
      try {
        const offset = append ? tracks.length : 0;
        const effectiveSort =
          group === "artists"
            ? "artist"
            : group === "albums"
              ? "album"
              : sortBy;
        const page = await api.tracks.query({
          libraryId,
          search,
          group,
          sortBy: effectiveSort,
          sortDirection: "asc",
          offset,
          limit: 500,
        });
        setTracks(current =>
          append ? [...current, ...page.items] : page.items,
        );
        setTotal(page.total);
      } catch (cause) {
        setError(message(cause));
      } finally {
        setLoading(false);
      }
    },
    [group, libraryId, search, sortBy, tracks.length],
  );

  useEffect(() => {
    void refreshLibraries();
  }, [refreshLibraries]);
  useEffect(() => {
    void api.organize
      .recoverable()
      .then(setRecoverable)
      .catch(cause => setError(message(cause)));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void loadTracks(false), 180);
    return () => clearTimeout(timer);
  }, [libraryId, search, group, sortBy]);
  useEffect(
    () =>
      api.jobs.subscribe(event => {
        setJobs(current => new Map(current).set(event.id, event));
        if (event.status === "completed" && event.kind === "scan") {
          void refreshLibraries();
          void loadTracks(false);
        }
      }),
    [loadTracks, refreshLibraries],
  );

  const toggleSelected = (id: number): void =>
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const activeJobs = [...jobs.values()].filter(
    job => job.status === "queued" || job.status === "running",
  );

  return (
    <div className="grid h-full grid-cols-[240px_minmax(520px,1fr)_360px] grid-rows-[1fr_68px] bg-slate-50">
      <aside className="row-start-1 flex min-h-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-4">
          <span className="grid size-9 place-items-center rounded-xl bg-violet-600 text-white">
            <MusicNote01 className="size-5" />
          </span>
          <div>
            <div className="font-semibold text-slate-900">Library Tagger</div>
            <div className="text-xs text-slate-500">Private music manager</div>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 pb-2 pt-5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Libraries
          </span>
          <Button
            variant="ghost"
            className="size-8 p-0"
            aria-label="Add libraries"
            onPress={() =>
              void api.libraries
                .chooseAndAdd()
                .then(setLibraries)
                .catch(cause => setError(message(cause)))
            }
          >
            <FolderPlus className="size-4" />
          </Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-auto px-2">
          <LibraryButton
            active={!libraryId}
            label="All music"
            count={libraries.reduce(
              (sum, library) => sum + library.trackCount,
              0,
            )}
            icon={<Library className="size-4" />}
            onClick={() => setLibraryId(undefined)}
          />
          {libraries.map(library => (
            <LibraryButton
              key={library.id}
              active={libraryId === library.id}
              label={library.name}
              count={library.trackCount}
              offline={!library.online}
              icon={<FaCompactDisc className="size-4" />}
              onClick={() => setLibraryId(library.id)}
            />
          ))}
        </nav>
        {libraryId && (
          <div className="px-2 pb-2">
            <Button
              variant="danger"
              className="w-full justify-start"
              onPress={() =>
                void api.libraries
                  .remove(libraryId)
                  .then(removed => {
                    if (!removed) return;
                    setLibraryId(undefined);
                    return refreshLibraries();
                  })
                  .catch(cause => setError(message(cause)))
              }
            >
              <Trash2 className="size-4" /> Remove library
            </Button>
          </div>
        )}
        <div className="border-t border-slate-200 p-2">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onPress={() => setSettingsOpen(true)}
          >
            <SettingsIcon className="size-4" /> Settings
          </Button>
        </div>
      </aside>

      <main className="row-start-1 flex min-h-0 min-w-0 flex-col">
        <header className="border-b border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search filename, title, artist, album, or path…"
                className="h-10 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
              />
            </div>
            <Button
              variant="secondary"
              isDisabled={!libraryId}
              onPress={() =>
                libraryId &&
                void api.libraries
                  .rescan(libraryId)
                  .catch(cause => setError(message(cause)))
              }
            >
              <RefreshCw className="size-4" /> Rescan
            </Button>
            <Button
              variant="secondary"
              isDisabled={!selectedIds.size}
              onPress={() => setOrganizeOpen(true)}
            >
              <FolderCog className="size-4" /> Organize{" "}
              <Badge tone="violet">{selectedIds.size}</Badge>
            </Button>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex rounded-lg bg-slate-100 p-1">
              {(["tracks", "artists", "albums"] as const).map(value => (
                <button
                  key={value}
                  onClick={() => setGroup(value)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-semibold capitalize",
                    group === value
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-700",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Sort by{" "}
              <select
                value={sortBy}
                onChange={event =>
                  setSortBy(event.target.value as TrackQuery["sortBy"])
                }
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-700"
              >
                <option value="title">Title</option>
                <option value="filename">Filename</option>
                <option value="artist">Artist</option>
                <option value="album">Album</option>
                <option value="year">Year</option>
                <option value="trackNumber">Track</option>
                <option value="format">Format</option>
                <option value="path">Path</option>
              </select>
            </label>
          </div>
        </header>
        {recoverable[0] && (
          <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900">
            <RefreshCw className="size-4" />
            <span className="flex-1">
              An organization batch was interrupted after{" "}
              {recoverable[0].completed} of {recoverable[0].total} moves.
            </span>
            <Button
              variant="secondary"
              onPress={() =>
                void api.organize
                  .resume(recoverable[0]!.id)
                  .then(() => {
                    setLastOperationId(recoverable[0]!.id);
                    setRecoverable(current => current.slice(1));
                    return loadTracks(false);
                  })
                  .catch(cause => setError(message(cause)))
              }
            >
              Resume safely
            </Button>
          </div>
        )}
        <TrackTable
          tracks={tracks}
          group={group}
          selectedIds={selectedIds}
          activeId={activeId}
          loading={loading}
          onToggle={toggleSelected}
          onActivate={setActiveId}
          onPlay={id => {
            setActiveId(id);
            setPlayerRequest(current => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
          }}
        />
        {tracks.length < total && (
          <div className="border-t border-slate-200 bg-white p-2 text-center">
            <Button
              variant="secondary"
              isDisabled={loading}
              onPress={() => void loadTracks(true)}
            >
              Load more ({tracks.length.toLocaleString()} of{" "}
              {total.toLocaleString()})
            </Button>
          </div>
        )}
      </main>

      <aside className="row-start-1 min-h-0 border-l border-slate-200 bg-white">
        {selectedIds.size > 1 ? (
          <BatchInspector
            trackIds={[...selectedIds]}
            onSaved={() => void loadTracks(false)}
            onError={value => setError(value)}
          />
        ) : (
          <Inspector
            trackId={activeId}
            onSaved={() => void loadTracks(false)}
            onError={value => setError(value)}
          />
        )}
      </aside>
      <footer className="col-span-3 row-start-2 grid grid-cols-[1fr_minmax(440px,2fr)_1fr] items-center border-t border-slate-200 bg-white px-4 text-xs text-slate-500">
        <span>
          {total.toLocaleString()} tracks · {libraries.length}{" "}
          {libraries.length === 1 ? "library" : "libraries"}
        </span>
        <Player tracks={tracks} activeId={activeId} request={playerRequest} onSelect={setActiveId} onError={value => setError(value)} />
        <span className="flex items-center justify-end gap-2">
          {activeJobs.length > 0 && (
            <>
              <LoaderCircle className="size-3 animate-spin" />
              {activeJobs.at(-1)?.message}
              <button
                aria-label="Cancel job"
                title="Cancel job"
                onClick={() => void api.jobs.cancel(activeJobs.at(-1)!.id)}
                className="rounded p-1 hover:bg-slate-100"
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
          {lastOperationId && (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onPress={() =>
                void api.organize
                  .undo(lastOperationId)
                  .then(() => {
                    setLastOperationId(null);
                    return loadTracks(false);
                  })
                  .catch(cause => setError(message(cause)))
              }
            >
              <Undo2 className="size-3.5" /> Undo last organization
            </Button>
          )}
        </span>
      </footer>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onError={value => setError(value)}
      />
      <OrganizeModal
        open={organizeOpen}
        onOpenChange={setOrganizeOpen}
        trackIds={[...selectedIds]}
        libraries={libraries}
        onApplied={operationId => {
          setLastOperationId(operationId);
          setSelectedIds(new Set());
          void loadTracks(false);
        }}
        onError={value => setError(value)}
      />
      {error && (
        <div
          role="alert"
          className="fixed bottom-12 left-1/2 z-[60] flex max-w-xl -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl"
        >
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}>
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function Player({
  tracks,
  activeId,
  request,
  onSelect,
  onError,
}: {
  tracks: TrackSummary[];
  activeId: number | null;
  request: { id: number; nonce: number } | null;
  onSelect(id: number): void;
  onError(error: string): void;
}): ReactNode {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTrack, setCurrentTrack] = useState<TrackSummary | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);

  useEffect(() => {
    if (!request) return;
    const requested = tracks.find(track => track.id === request.id);
    if (!requested?.available) return;
    setCurrentTrack(requested);
    setElapsed(0);
    setDuration(0);
    setPlaying(true);
  }, [request]);
  useEffect(() => {
    const refreshed = tracks.find(track => track.id === currentTrack?.id);
    if (refreshed) setCurrentTrack(refreshed);
  }, [tracks, currentTrack?.id]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) void audio.play().catch(() => {
      setPlaying(false);
      onError("This audio format could not be played");
    });
    else audio.pause();
  }, [currentTrack?.id, playing]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, currentTrack?.id]);

  const choose = (track: TrackSummary): void => {
    setCurrentTrack(track);
    setElapsed(0);
    setDuration(0);
    setPlaying(true);
    onSelect(track.id);
  };
  const move = (offset: -1 | 1): void => {
    const playable = tracks.filter(track => track.available);
    if (!playable.length) return;
    const index = playable.findIndex(track => track.id === currentTrack?.id);
    choose(playable[index < 0 ? 0 : (index + offset + playable.length) % playable.length]!);
  };
  const toggle = (): void => {
    if (currentTrack) {
      setPlaying(value => !value);
      return;
    }
    const first = tracks.find(track => track.id === activeId && track.available) ?? tracks.find(track => track.available);
    if (first) choose(first);
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(120px,1fr)_auto_minmax(150px,1fr)] items-center gap-3 px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-100">
          {currentTrack?.coverUrl ? <img src={currentTrack.coverUrl} className="size-full object-cover" /> : <MusicNote01 className="size-4 text-slate-400" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-slate-800">{currentTrack?.title ?? currentTrack?.filename ?? "Nothing playing"}</span>
          <span className="block truncate text-[11px] text-slate-400">{currentTrack?.artists.join(", ") || "Double-click a track to play"}</span>
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button className="rounded-full p-2 text-slate-500 hover:bg-slate-100" onClick={() => move(-1)} aria-label="Previous track"><SkipBack className="size-4" /></button>
        <button className="grid size-9 place-items-center rounded-full bg-violet-600 text-white hover:bg-violet-700" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
        </button>
        <button className="rounded-full p-2 text-slate-500 hover:bg-slate-100" onClick={() => move(1)} aria-label="Next track"><SkipForward className="size-4" /></button>
      </div>
      <div className="flex min-w-0 items-center gap-2 tabular-nums">
        <span className="w-8 text-right text-[10px]">{formatTime(elapsed)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(elapsed, duration || 0)}
          onChange={event => {
            const next = Number(event.target.value);
            if (audioRef.current) audioRef.current.currentTime = next;
            setElapsed(next);
          }}
          className="min-w-20 flex-1 accent-violet-600"
          aria-label="Playback position"
        />
        <span className="w-8 text-[10px]">{formatTime(duration)}</span>
        <Volume2 className="ml-1 size-3.5" />
        <input type="range" min={0} max={1} step={0.05} value={volume} onChange={event => setVolume(Number(event.target.value))} className="w-16 accent-violet-600" aria-label="Volume" />
      </div>
      {currentTrack && (
        <audio
          ref={audioRef}
          src={`media://track/${currentTrack.id}`}
          onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onTimeUpdate={event => setElapsed(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => move(1)}
        />
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function LibraryButton({
  active,
  label,
  count,
  offline,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  offline?: boolean;
  icon: ReactNode;
  onClick(): void;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        "mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
        active
          ? "bg-violet-50 font-semibold text-violet-700"
          : "text-slate-600 hover:bg-slate-50",
      )}
    >
      <span>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {offline ? (
        <Badge tone="amber">offline</Badge>
      ) : (
        <span className="text-xs tabular-nums text-slate-400">{count}</span>
      )}
    </button>
  );
}

function TrackTable({
  tracks,
  group,
  selectedIds,
  activeId,
  loading,
  onToggle,
  onActivate,
  onPlay,
}: {
  tracks: TrackSummary[];
  group: TrackQuery["group"];
  selectedIds: Set<number>;
  activeId: number | null;
  loading: boolean;
  onToggle(id: number): void;
  onActivate(id: number): void;
  onPlay(id: number): void;
}): ReactNode {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const result: Array<
      { type: "group"; key: string } | { type: "track"; track: TrackSummary }
    > = [];
    let previous: string | null = null;
    for (const track of tracks) {
      const key =
        group === "artists"
          ? track.artists[0] || "Unknown Artist"
          : group === "albums"
            ? track.album || "Unknown Album"
            : null;
      if (key && key !== previous) {
        result.push({ type: "group", key });
        previous = key;
      }
      result.push({ type: "track", track });
    }
    return result;
  }, [tracks, group]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: index => (rows[index]?.type === "group" ? 34 : 55),
    overscan: 10,
  });
  if (!loading && tracks.length === 0)
    return (
      <div className="grid flex-1 place-items-center">
        <div className="text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-xl bg-slate-100">
            <ListMusic className="size-6 text-slate-400" />
          </span>
          <h2 className="mt-3 font-semibold">No tracks found</h2>
          <p className="mt-1 text-sm text-slate-500">
            Add a library or adjust your search.
          </p>
        </div>
      </div>
    );
  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 grid h-9 grid-cols-[42px_minmax(200px,1.5fr)_minmax(140px,1fr)_minmax(140px,1fr)_72px_86px_90px] items-center border-b border-slate-200 bg-slate-50/95 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 backdrop-blur">
        <span />
        <span>Track</span>
        <span>Artist</span>
        <span>Album</span>
        <span>Lyrics</span>
        <span>Status</span>
        <span>Format</span>
      </div>
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(virtual => {
          const row = rows[virtual.index]!;
          if (row.type === "group")
            return (
              <div
                key={`group-${row.key}`}
                className="absolute left-0 top-0 flex w-full items-center gap-2 border-b border-slate-200 bg-slate-100 px-4 text-xs font-semibold text-slate-600"
                style={{
                  height: virtual.size,
                  transform: `translateY(${virtual.start}px)`,
                }}
              >
                <span className="grid size-5 place-items-center rounded bg-white">
                  <FaCompactDisc className="size-3" />
                </span>
                {row.key}
              </div>
            );
          const track = row.track;
          const missing = !track.title || !track.artists.length || !track.album;
          return (
            <div
              key={track.id}
              className={cn(
                "absolute left-0 top-0 grid w-full grid-cols-[42px_minmax(200px,1.5fr)_minmax(140px,1fr)_minmax(140px,1fr)_72px_86px_90px] items-center border-b border-slate-100 px-3 text-sm hover:bg-slate-50",
                activeId === track.id && "bg-violet-50 hover:bg-violet-50",
                !track.available && "opacity-55",
              )}
              style={{
                height: virtual.size,
                transform: `translateY(${virtual.start}px)`,
              }}
              onDoubleClick={() => onPlay(track.id)}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(track.id)}
                onChange={() => onToggle(track.id)}
                className="size-4 accent-violet-600"
                aria-label={`Select ${track.title ?? track.filename}`}
              />
              <button
                className="min-w-0 text-left"
                onClick={() => onActivate(track.id)}
              >
                <div className="truncate font-medium text-slate-800">
                  {track.title || track.filename}
                </div>
                <div
                  className={cn(
                    "truncate text-xs",
                    track.error ? "text-red-500" : "text-slate-400",
                  )}
                >
                  {track.error ? `Read error: ${track.error}` : track.filename}
                </div>
              </button>
              <span className="truncate text-slate-600">
                {track.artists.join(", ") || "—"}
              </span>
              <span className="truncate text-slate-600">
                {track.album || "—"}
              </span>
              <span>
                {track.lyrics.sidecar || track.lyrics.embedded ? (
                  <Badge tone={track.lyrics.synchronized ? "violet" : "green"}>
                    {track.lyrics.synchronized ? "LRC" : "Yes"}
                  </Badge>
                ) : (
                  <Badge>No</Badge>
                )}
              </span>
              <span className="flex items-center gap-1 text-slate-400">
                {track.error || missing ? (
                  <AlertTriangle
                    className="size-3.5 text-amber-500"
                    aria-label={track.error ? "Read error" : "Missing metadata"}
                  />
                ) : null}
                {track.hasCover && (
                  <ImageIcon
                    className="size-3.5 text-emerald-500"
                    aria-label="Has cover"
                  />
                )}
                {!track.writable && (
                  <LockKeyhole className="size-3.5" aria-label="Read only" />
                )}
              </span>
              <span className="flex items-center gap-1.5 uppercase text-slate-500">
                <FileAudio className="size-3.5" />
                {track.format}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Inspector({
  trackId,
  onSaved,
  onError,
}: {
  trackId: number | null;
  onSaved(): void;
  onError(error: string): void;
}): ReactNode {
  const [track, setTrack] = useState<TrackDetails | null>(null);
  const [form, setForm] = useState<TrackDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<ProviderCandidate[]>([]);
  const [cover, setCover] = useState<TagPatch["cover"]>();
  const [writeFolderCover, setWriteFolderCover] = useState(false);
  const [savePreviewOpen, setSavePreviewOpen] = useState(false);
  useEffect(() => {
    setCandidates([]);
    setCover(undefined);
    setWriteFolderCover(false);
    setSavePreviewOpen(false);
    if (!trackId) {
      setTrack(null);
      setForm(null);
      return;
    }
    setBusy(true);
    void api.tracks
      .details(trackId)
      .then(value => {
        setTrack(value);
        setForm(value);
      })
      .catch(cause => onError(message(cause)))
      .finally(() => setBusy(false));
  }, [trackId]);
  if (!trackId)
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-slate-500">
        <div>
          <Tags className="mx-auto mb-3 size-8 text-slate-300" />
          Select a track to inspect and edit its metadata.
        </div>
      </div>
    );
  if (busy || !form || !track)
    return (
      <div className="grid h-full place-items-center">
        <LoaderCircle className="size-5 animate-spin text-violet-600" />
      </div>
    );
  const update = <K extends keyof TrackDetails>(
    key: K,
    value: TrackDetails[K],
  ): void =>
    setForm(current => (current ? { ...current, [key]: value } : current));
  const lookup = async (
    kind: "metadata" | "lyrics" | "fingerprint",
  ): Promise<void> => {
    setBusy(true);
    try {
      setCandidates(await api.lookup[kind](track.id));
    } catch (cause) {
      onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.tracks.save(track.id, {
        title: form.title,
        artists: form.artists,
        albumArtists: form.albumArtists,
        album: form.album,
        trackNumber: form.trackNumber,
        trackTotal: form.trackTotal,
        discNumber: form.discNumber,
        discTotal: form.discTotal,
        date: form.date,
        genres: form.genres,
        composers: form.composers,
        comment: form.comment,
        identifiers: form.identifiers,
        removedIdentifiers: Object.keys(track.identifiers).filter(key => !(key in form.identifiers)),
        embeddedLyrics: form.embeddedLyrics,
        sidecarLyrics: form.sidecarLyrics,
        advancedTags: form.advancedTags.filter(tag => tag.key.trim()),
        removedAdvancedTags: track.advancedTags.map(tag => tag.key).filter(key => !form.advancedTags.some(tag => tag.key === key)),
        cover,
        writeFolderCover,
        expectedSize: track.size,
        expectedModifiedMs: track.modifiedMs,
      });
      const refreshed = await api.tracks.details(track.id);
      setTrack(refreshed);
      setForm(refreshed);
      setCover(undefined);
      setWriteFolderCover(false);
      onSaved();
    } catch (cause) {
      onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const chooseCover = (file?: File): void => {
    if (!file) return;
    if (
      !["image/jpeg", "image/png"].includes(file.type) ||
      file.size > 20 * 1024 * 1024
    ) {
      onError("Choose a JPEG or PNG under 20 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      setCover({
        mimeType: file.type as "image/jpeg" | "image/png",
        dataBase64: String(reader.result).split(",")[1]!,
      });
    reader.readAsDataURL(file);
  };
  const changes = trackChanges(track, form, cover, writeFolderCover);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <div className="font-semibold">Metadata</div>
          <div className="max-w-[220px] truncate text-xs text-slate-400">
            {track.relativePath}
          </div>
        </div>
        <Button
          isDisabled={busy || !track.writable || !changes.length}
          onPress={() => setSavePreviewOpen(true)}
        >
          <Save className="size-4" /> Save
        </Button>
      </div>
      <div className="flex-1 space-y-5 overflow-auto p-4">
        {!track.writable && (
          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            This format is indexed read-only.
          </div>
        )}
        {track.error && (
          <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
            Metadata could not be read: {track.error}
          </div>
        )}
        <div className="flex gap-3">
          <div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100">
            {cover === null ? (
              <ImagePlus className="size-6 text-slate-300" />
            ) : cover ? (
              <img
                className="size-full object-cover"
                src={`data:${cover.mimeType};base64,${cover.dataBase64}`}
              />
            ) : form.coverUrl ? (
              <img className="size-full object-cover" src={form.coverUrl} />
            ) : (
              <ImagePlus className="size-6 text-slate-400" />
            )}
          </div>
          <div className="grid content-center gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <ImagePlus className="size-4" /> Choose cover
              <input
                hidden
                type="file"
                accept="image/jpeg,image/png"
                onChange={event => chooseCover(event.target.files?.[0])}
              />
            </label>
            {(cover || form.hasCover) && (
              <Button variant="ghost" onPress={() => setCover(null)}>
                Remove cover
              </Button>
            )}
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={writeFolderCover}
                disabled={!cover}
                onChange={event => setWriteFolderCover(event.target.checked)}
                className="accent-violet-600"
              />{" "}
              Also write folder.jpg
            </label>
          </div>
        </div>
        <Field
          label="Title"
          value={form.title ?? ""}
          onChange={event => update("title", event.target.value || null)}
        />
        <Field
          label="Artists (semicolon separated)"
          value={form.artists.join("; ")}
          onChange={event => update("artists", list(event.target.value))}
        />
        <Field
          label="Album artists"
          value={form.albumArtists.join("; ")}
          onChange={event => update("albumArtists", list(event.target.value))}
        />
        <Field
          label="Album"
          value={form.album ?? ""}
          onChange={event => update("album", event.target.value || null)}
        />
        <div className="grid grid-cols-4 gap-2">
          <NumberField
            label="Track"
            value={form.trackNumber}
            onChange={value => update("trackNumber", value)}
          />
          <NumberField
            label="of"
            value={form.trackTotal}
            onChange={value => update("trackTotal", value)}
          />
          <NumberField
            label="Disc"
            value={form.discNumber}
            onChange={value => update("discNumber", value)}
          />
          <NumberField
            label="of"
            value={form.discTotal}
            onChange={value => update("discTotal", value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Date"
            value={form.date ?? ""}
            onChange={event => update("date", event.target.value || null)}
          />
          <Field
            label="Genres"
            value={form.genres.join("; ")}
            onChange={event => update("genres", list(event.target.value))}
          />
        </div>
        <Field
          label="Composers"
          value={form.composers.join("; ")}
          onChange={event => update("composers", list(event.target.value))}
        />
        <label className="grid gap-1.5 text-xs font-medium text-slate-600">
          Comment
          <textarea
            value={form.comment ?? ""}
            onChange={event => update("comment", event.target.value || null)}
            className="min-h-20 rounded-lg border border-slate-300 p-3 text-sm outline-none focus:border-violet-500"
          />
        </label>
        <Identifiers
          values={form.identifiers}
          onChange={value => update("identifiers", value)}
        />
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Lyrics
          </h3>
          <label className="grid gap-1 text-xs text-slate-500">
            Embedded
            <textarea
              value={form.embeddedLyrics ?? ""}
              onChange={event =>
                update("embeddedLyrics", event.target.value || null)
              }
              className="mt-1 min-h-36 rounded-lg border border-slate-300 p-3 font-mono text-xs outline-none focus:border-violet-500"
            />
          </label>
          <label className="mt-3 grid gap-1 text-xs text-slate-500">
            Synchronized .lrc
            <textarea
              value={form.sidecarLyrics ?? ""}
              onChange={event =>
                update("sidecarLyrics", event.target.value || null)
              }
              className="mt-1 min-h-36 rounded-lg border border-slate-300 p-3 font-mono text-xs outline-none focus:border-violet-500"
            />
          </label>
        </section>
        <AdvancedTags
          tags={form.advancedTags}
          onChange={value => update("advancedTags", value)}
        />
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Online suggestions
          </h3>
          <div className="grid grid-cols-3 gap-2">
            <Button variant="secondary" onPress={() => void lookup("metadata")}>
              <Sparkles className="size-3.5" /> Tags
            </Button>
            <Button variant="secondary" onPress={() => void lookup("lyrics")}>
              <ListMusic className="size-3.5" /> Lyrics
            </Button>
            <Button
              variant="secondary"
              onPress={() => void lookup("fingerprint")}
            >
              <Fingerprint className="size-3.5" /> Identify
            </Button>
          </div>
          {candidates.map(candidate => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              current={form}
              onApply={async fields => {
                let stagedCover = cover;
                if (fields.has("coverUrl") && candidate.coverUrl)
                  stagedCover = await api.lookup.downloadArtwork(
                    candidate.coverUrl,
                  );
                setCover(stagedCover);
                setForm(current =>
                  current
                    ? applyCandidate(current, candidate, fields)
                    : current,
                );
              }}
              onError={onError}
            />
          ))}
        </section>
      </div>
      <AppModal
        open={savePreviewOpen}
        onOpenChange={setSavePreviewOpen}
        title="Review changes"
        size="md"
      >
        <div className="min-h-0 overflow-auto p-6">
          <p className="mb-4 text-sm text-slate-600">
            These changes will be written atomically to{" "}
            <span className="font-semibold text-slate-800">{track.filename}</span>.
          </p>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            {changes.map(change => (
              <div key={change} className="border-b border-slate-100 px-3 py-2 text-xs text-slate-700 last:border-0">
                {change}
              </div>
            ))}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onPress={() => setSavePreviewOpen(false)}>Keep editing</Button>
            <Button onPress={() => { setSavePreviewOpen(false); void save(); }}><Save className="size-4" /> Save changes</Button>
          </div>
        </div>
      </AppModal>
    </div>
  );
}

type BatchField =
  | "title"
  | "artists"
  | "albumArtists"
  | "album"
  | "date"
  | "genres"
  | "composers"
  | "comment"
  | "trackTotal"
  | "discNumber"
  | "discTotal";

function BatchInspector({
  trackIds,
  onSaved,
  onError,
}: {
  trackIds: number[];
  onSaved(): void;
  onError(error: string): void;
}): ReactNode {
  const [enabled, setEnabled] = useState<Set<BatchField>>(new Set());
  const [values, setValues] = useState<Record<BatchField, string>>({
    title: "",
    artists: "",
    albumArtists: "",
    album: "",
    date: "",
    genres: "",
    composers: "",
    comment: "",
    trackTotal: "",
    discNumber: "",
    discTotal: "",
  });
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(0);
  const selectionKey = trackIds.join(",");
  useEffect(() => {
    setEnabled(new Set());
    setCompleted(0);
  }, [selectionKey]);
  const toggle = (field: BatchField): void =>
    setEnabled(current => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  const save = async (): Promise<void> => {
    setBusy(true);
    setCompleted(0);
    let saved = 0;
    try {
      for (let index = 0; index < trackIds.length; index += 1) {
        const track = await api.tracks.details(trackIds[index]!);
        if (!track.writable)
          throw new Error(
            `${track.filename} is read-only; no further tracks were changed`,
          );
        const patch: TagPatch = {
          expectedSize: track.size,
          expectedModifiedMs: track.modifiedMs,
        };
        if (enabled.has("title")) patch.title = values.title || null;
        if (enabled.has("artists")) patch.artists = list(values.artists);
        if (enabled.has("albumArtists"))
          patch.albumArtists = list(values.albumArtists);
        if (enabled.has("album")) patch.album = values.album || null;
        if (enabled.has("date")) patch.date = values.date || null;
        if (enabled.has("genres")) patch.genres = list(values.genres);
        if (enabled.has("composers")) patch.composers = list(values.composers);
        if (enabled.has("comment")) patch.comment = values.comment || null;
        if (enabled.has("trackTotal"))
          patch.trackTotal = positiveOrNull(values.trackTotal);
        if (enabled.has("discNumber"))
          patch.discNumber = positiveOrNull(values.discNumber);
        if (enabled.has("discTotal"))
          patch.discTotal = positiveOrNull(values.discTotal);
        await api.tracks.save(track.id, patch);
        saved = index + 1;
        setCompleted(index + 1);
      }
      onSaved();
    } catch (cause) {
      onError(`${message(cause)} (${saved} of ${trackIds.length} saved)`);
    } finally {
      setBusy(false);
    }
  };
  const row = (
    field: BatchField,
    label: string,
    placeholder = "Leave blank to clear",
  ): ReactNode => (
    <label className="grid grid-cols-[20px_1fr] items-end gap-2">
      <input
        type="checkbox"
        checked={enabled.has(field)}
        onChange={() => toggle(field)}
        className="mb-2.5 size-4 accent-violet-600"
      />
      <Field
        label={label}
        value={values[field]}
        placeholder={placeholder}
        disabled={!enabled.has(field) || busy}
        onChange={event =>
          setValues(current => ({ ...current, [field]: event.target.value }))
        }
      />
    </label>
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <div className="font-semibold">Batch metadata</div>
          <div className="text-xs text-slate-400">
            {trackIds.length} selected tracks
          </div>
        </div>
        <Button isDisabled={busy || !enabled.size} onPress={() => void save()}>
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}{" "}
          Save {busy ? `${completed}/${trackIds.length}` : "selected"}
        </Button>
      </div>
      <div className="flex-1 space-y-3 overflow-auto p-4">
        <p className="rounded-lg bg-violet-50 p-3 text-xs leading-5 text-violet-800">
          Only checked fields are changed. Blank checked fields are cleared.
          Files are still stale-checked and written atomically one at a time.
        </p>
        {row("title", "Title")}
        {row("artists", "Artists", "Semicolon separated")}
        {row("albumArtists", "Album artists", "Semicolon separated")}
        {row("album", "Album")}
        {row("date", "Date / year")}
        {row("genres", "Genres", "Semicolon separated")}
        {row("composers", "Composers / credits", "Semicolon separated")}
        {row("comment", "Comment")}
        {row("trackTotal", "Track total")}
        {row("discNumber", "Disc number")}
        {row("discTotal", "Disc total")}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  current,
  onApply,
  onError,
}: {
  candidate: ProviderCandidate;
  current: TrackDetails;
  onApply(fields: Set<string>): Promise<void>;
  onError(error: string): void;
}): ReactNode {
  const options = candidateFields(candidate);
  const [selected, setSelected] = useState(
    new Set(options.map(([key]) => key)),
  );
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <div>
          <Badge tone="violet">{candidate.source}</Badge>
          <span className="ml-2 text-xs font-semibold text-slate-600">
            {Math.round(candidate.confidence * 100)}% match
          </span>
        </div>
        <Button
          variant="secondary"
          isDisabled={!selected.size || busy}
          onPress={() => {
            setBusy(true);
            void onApply(selected)
              .catch(cause => onError(message(cause)))
              .finally(() => setBusy(false));
          }}
        >
          <Check className="size-3.5" /> Stage selected
        </Button>
      </div>
      <div className="mt-2 space-y-1">
        {options.map(([key, label, value]) => (
          <label
            key={key}
            className="flex items-start gap-2 rounded-md p-1 text-xs hover:bg-slate-50"
          >
            <input
              className="mt-0.5 accent-violet-600"
              type="checkbox"
              checked={selected.has(key)}
              onChange={() =>
                setSelected(current => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
            <span className="w-16 shrink-0 text-slate-400">{label}</span>
            <span className="min-w-0 text-slate-700">
              <span className="line-clamp-1 text-slate-400 line-through">{currentCandidateValue(current, key)}</span>
              <span className="flex items-start gap-1"><ArrowRight className="mt-0.5 size-3 shrink-0 text-violet-500" /><span className="line-clamp-2">{value}</span></span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-2 text-[10px] text-slate-400">
        {candidate.attribution} · changes are staged, not saved
      </div>
    </div>
  );
}

function candidateFields(
  candidate: ProviderCandidate,
): Array<[string, string, string]> {
  const fields: Array<[string, string, string]> = [];
  if (candidate.title) fields.push(["title", "Title", candidate.title]);
  if (candidate.artists?.length)
    fields.push(["artists", "Artists", candidate.artists.join(", ")]);
  if (candidate.album) fields.push(["album", "Album", candidate.album]);
  if (candidate.albumArtist)
    fields.push(["albumArtist", "Album artist", candidate.albumArtist]);
  if (candidate.date) fields.push(["date", "Date", candidate.date]);
  if (candidate.plainLyrics)
    fields.push(["plainLyrics", "Lyrics", candidate.plainLyrics]);
  if (candidate.syncedLyrics)
    fields.push(["syncedLyrics", "LRC", candidate.syncedLyrics]);
  if (candidate.coverUrl)
    fields.push(["coverUrl", "Cover", "Download front cover"]);
  if (candidate.identifiers)
    fields.push([
      "identifiers",
      "IDs",
      Object.entries(candidate.identifiers)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", "),
    ]);
  return fields;
}
function applyCandidate(
  track: TrackDetails,
  candidate: ProviderCandidate,
  selected: Set<string>,
): TrackDetails {
  return {
    ...track,
    ...(selected.has("title") ? { title: candidate.title ?? null } : {}),
    ...(selected.has("artists") ? { artists: candidate.artists ?? [] } : {}),
    ...(selected.has("album") ? { album: candidate.album ?? null } : {}),
    ...(selected.has("albumArtist")
      ? { albumArtists: candidate.albumArtist ? [candidate.albumArtist] : [] }
      : {}),
    ...(selected.has("date") ? { date: candidate.date ?? null } : {}),
    ...(selected.has("plainLyrics")
      ? { embeddedLyrics: candidate.plainLyrics ?? null }
      : {}),
    ...(selected.has("syncedLyrics")
      ? { sidecarLyrics: candidate.syncedLyrics ?? null }
      : {}),
    ...(selected.has("identifiers")
      ? { identifiers: { ...track.identifiers, ...candidate.identifiers } }
      : {}),
  };
}

function currentCandidateValue(track: TrackDetails, key: string): string {
  const values: Record<string, string> = {
    title: track.title ?? "—", artists: track.artists.join(", ") || "—", album: track.album ?? "—",
    albumArtist: track.albumArtists.join(", ") || "—", date: track.date ?? "—",
    plainLyrics: track.embeddedLyrics ? "Existing embedded lyrics" : "No embedded lyrics",
    syncedLyrics: track.sidecarLyrics ? "Existing .lrc lyrics" : "No .lrc lyrics",
    coverUrl: track.hasCover ? "Existing front cover" : "No front cover",
    identifiers: Object.entries(track.identifiers).map(([name, value]) => `${name}: ${value}`).join(", ") || "—"
  };
  return values[key] ?? "—";
}

function trackChanges(track: TrackDetails, form: TrackDetails, cover: TagPatch["cover"], writeFolderCover: boolean): string[] {
  const metadata: Array<[string, unknown, unknown]> = [
    ["Title", track.title, form.title], ["Artists", track.artists, form.artists], ["Album artists", track.albumArtists, form.albumArtists],
    ["Album", track.album, form.album], ["Track", [track.trackNumber, track.trackTotal], [form.trackNumber, form.trackTotal]],
    ["Disc", [track.discNumber, track.discTotal], [form.discNumber, form.discTotal]], ["Date", track.date, form.date],
    ["Genres", track.genres, form.genres], ["Composers / credits", track.composers, form.composers], ["Comment", track.comment, form.comment],
    ["Identifiers", track.identifiers, form.identifiers], ["Embedded lyrics", track.embeddedLyrics, form.embeddedLyrics],
    ["Synchronized .lrc", track.sidecarLyrics, form.sidecarLyrics],
    ["Advanced tags", track.advancedTags, form.advancedTags.filter(tag => tag.key.trim())]
  ];
  const changes = metadata.filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after)).map(([label, before, after]) => `${label}: ${previewValue(before)} → ${previewValue(after)}`);
  if (cover !== undefined) changes.push(cover === null ? "Front cover: remove embedded artwork" : `Front cover: replace with ${cover.mimeType === "image/png" ? "PNG" : "JPEG"} artwork`);
  if (writeFolderCover && cover) changes.push("Album artwork: write or replace folder.jpg");
  return changes;
}

function previewValue(value: unknown): string {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return "empty";
  if (typeof value === "string") return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  if (Array.isArray(value)) return value.map(item => typeof item === "object" ? JSON.stringify(item) : String(item ?? "—")).join(" / ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function AdvancedTags({
  tags,
  onChange,
}: {
  tags: TrackDetails["advancedTags"];
  onChange(value: TrackDetails["advancedTags"]): void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  return (
    <section>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        Advanced text tags{" "}
        <ChevronDown
          className={cn("size-4 transition", expanded && "rotate-180")}
        />
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {tags.map((tag, index) => (
            <div
              className="grid grid-cols-[1fr_1.4fr_28px] gap-2"
              key={`${index}-${tag.key}`}
            >
              <input
                value={tag.key}
                onChange={event =>
                  onChange(
                    tags.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, key: event.target.value }
                        : item,
                    ),
                  )
                }
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
              <input
                value={tag.value}
                onChange={event =>
                  onChange(
                    tags.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, value: event.target.value }
                        : item,
                    ),
                  )
                }
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
              <button
                onClick={() =>
                  onChange(tags.filter((_, itemIndex) => itemIndex !== index))
                }
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            onPress={() => onChange([...tags, { key: "", value: "" }])}
          >
            Add tag
          </Button>
        </div>
      )}
    </section>
  );
}

function Identifiers({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange(value: Record<string, string>): void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(values);
  const replace = (index: number, key: string, value: string): void =>
    onChange(
      Object.fromEntries(
        entries
          .map(([oldKey, oldValue], itemIndex) =>
            itemIndex === index ? [key, value] : [oldKey, oldValue],
          )
          .filter(entry => (entry[0] ?? "").trim()),
      ),
    );
  return (
    <section>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        Identifiers{" "}
        <ChevronDown
          className={cn("size-4 transition", expanded && "rotate-180")}
        />
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {entries.map(([key, value], index) => (
            <div
              className="grid grid-cols-[1fr_1.4fr_28px] gap-2"
              key={`${index}-${key}`}
            >
              <input
                value={key}
                onChange={event => replace(index, event.target.value, value)}
                placeholder="isrc"
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
              <input
                value={value}
                onChange={event => replace(index, key, event.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
              <button
                onClick={() =>
                  onChange(
                    Object.fromEntries(
                      entries.filter((_, itemIndex) => itemIndex !== index),
                    ),
                  )
                }
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            onPress={() =>
              onChange({
                ...values,
                [`newIdentifier${entries.length + 1}`]: "",
              })
            }
          >
            Add identifier
          </Button>
        </div>
      )}
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange(value: number | null): void;
}): ReactNode {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-slate-600">
      {label}
      <input
        type="number"
        min={1}
        value={value ?? ""}
        onChange={event =>
          onChange(event.target.value ? Number(event.target.value) : null)
        }
        className="h-9 rounded-lg border border-slate-300 px-2 text-sm outline-none focus:border-violet-500"
      />
    </label>
  );
}

function SettingsModal({
  open,
  onOpenChange,
  onError,
}: {
  open: boolean;
  onOpenChange(value: boolean): void;
  onError(error: string): void;
}): ReactNode {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    if (open)
      void api.settings
        .get()
        .then(setSettings)
        .catch(cause => onError(message(cause)));
  }, [open]);
  return (
    <AppModal
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      size="md"
    >
      <div className="space-y-4 overflow-auto p-6">
        {settings && (
          <>
            <Field
              label="Provider contact or project URL"
              value={settings.providerContact}
              onChange={event =>
                setSettings({
                  ...settings,
                  providerContact: event.target.value,
                })
              }
            />
            <Field
              label="Private AcoustID client key"
              type="password"
              value={settings.acoustIdKey}
              onChange={event =>
                setSettings({ ...settings, acoustIdKey: event.target.value })
              }
            />
            <Field
              label="Organization template"
              value={settings.organizationTemplate}
              onChange={event =>
                setSettings({
                  ...settings,
                  organizationTemplate: event.target.value,
                })
              }
            />
            <p className="text-xs leading-5 text-slate-500">
              Tokens:{" "}
              {
                "{albumArtist} {artist} {album} {discFolder} {track:02} {title} {ext}"
              }
              . Provider lookups are initiated only when you request them.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            isDisabled={!settings}
            onPress={() =>
              settings &&
              void api.settings
                .set(settings)
                .then(() => onOpenChange(false))
                .catch(cause => onError(message(cause)))
            }
          >
            Save settings
          </Button>
        </div>
      </div>
    </AppModal>
  );
}

function OrganizeModal({
  open,
  onOpenChange,
  trackIds,
  libraries,
  onApplied,
  onError,
}: {
  open: boolean;
  onOpenChange(value: boolean): void;
  trackIds: number[];
  libraries: LibraryModel[];
  onApplied(operationId: string): void;
  onError(error: string): void;
}): ReactNode {
  const [destination, setDestination] = useState<number | "">(
    libraries[0]?.id ?? "",
  );
  const [template, setTemplate] = useState(
    "{albumArtist}/{album}/{discFolder}{track:02} - {title}.{ext}",
  );
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPlan(null);
      void api.settings
        .get()
        .then(value => setTemplate(value.organizationTemplate));
    }
  }, [open]);
  const preview = async (): Promise<void> => {
    if (!destination) return;
    setBusy(true);
    try {
      setPlan(
        await api.organize.preview({
          trackIds,
          destinationLibraryId: destination,
          template,
        }),
      );
    } catch (cause) {
      onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Organize ${trackIds.length} tracks`}
      size="xl"
    >
      <div className="min-h-0 overflow-auto p-6">
        <div className="grid grid-cols-[220px_1fr_auto] gap-3">
          <label className="grid gap-1 text-xs font-medium text-slate-600">
            Destination library
            <select
              value={destination}
              onChange={event => setDestination(Number(event.target.value))}
              className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm"
            >
              {libraries.map(library => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="Path template"
            value={template}
            onChange={event => setTemplate(event.target.value)}
          />
          <Button
            className="self-end"
            isDisabled={!trackIds.length || !destination || busy}
            onPress={() => void preview()}
          >
            Preview
          </Button>
        </div>
        {plan && (
          <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
            <div className="grid grid-cols-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
              <span>Current</span>
              <span>Destination</span>
            </div>
            {plan.items.map(item => (
              <div
                key={item.trackId}
                className="grid grid-cols-2 gap-3 border-t border-slate-100 px-3 py-2 text-xs"
              >
                <span className="truncate text-slate-500">
                  {item.sourcePath}
                </span>
                <span
                  className={cn(
                    "truncate",
                    item.conflict ? "text-red-600" : "text-slate-800",
                  )}
                >
                  {item.conflict ?? item.destinationPath}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            isDisabled={!plan?.canApply || busy}
            onPress={() => {
              if (!plan) return;
              setBusy(true);
              void api.organize
                .apply(plan.id)
                .then(operationId => {
                  onOpenChange(false);
                  onApplied(operationId);
                })
                .catch(cause => onError(message(cause)))
                .finally(() => setBusy(false));
            }}
          >
            Apply moves
          </Button>
        </div>
      </div>
    </AppModal>
  );
}

function list(value: string): string[] {
  return value
    .split(";")
    .map(item => item.trim())
    .filter(Boolean);
}
function positiveOrNull(value: string): number | null {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
