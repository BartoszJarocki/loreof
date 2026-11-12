'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { preload } from 'react-dom';
import Link from 'next/link';
import type { Commit, FileTrack } from '@/lib/schema';
import {
  loadSnapshotParts,
  PART_IDLE_MS,
  retrySnapshotTouches,
  touchesBytes,
  unpackPaths,
  type SnapshotMap,
  type Story,
  type Touches,
} from '@/lib/snapshot-pack';
import { selectedEraForPin } from '@/viewer/era-pin';
import {
  chapterAtSeconds,
  clamp,
  commitAtSeconds,
  eraIndexAt,
  formatDate,
  formatNumber,
  monthStamp,
  pathAt,
  pinnedUrl,
  resolveTimePin,
  secondsAtCommit,
  TOUR_SECONDS,
} from '@/viewer/playback';
import {
  beatSpeed,
  buildBeats,
  ENVELOPE_SECONDS,
  envelope,
  invertTouches,
  nextBeat,
  previousBeat,
  touchedAt,
  touchActivity,
  type Beat,
} from '@/viewer/beats';
import type { FrameBox } from '@/viewer/framing';
import type { SceneHandle } from '@/viewer/scene';
import { createRenderLoop } from '@/viewer/render-loop';
import { recordCanvas } from '@/viewer/recording';
import { chapterView } from '@/viewer/story';
import { css, readPalette } from '@/viewer/tokens';
import { ExternalLink } from './Index';
import { Stage, type StageState } from './viewer/Stage';
import { Timeline } from './viewer/Timeline';
import { Chapter } from './viewer/Chapter';
import { ChapterCard } from './viewer/ChapterCard';
import { Chapters, ChaptersDialog } from './viewer/Chapters';
import { FindFile } from './viewer/FindFile';
import { Geist } from '@/fonts/geist';
import './viewer.css';

type Loaded = { map: SnapshotMap; commits: Pick<Commit, 'time'>[]; touches: Touches | null };
type MapPart =
  | { kind: 'pending' }
  | { kind: 'loaded'; map: SnapshotMap; commits: Pick<Commit, 'time'>[] }
  | { kind: 'failed' };
type TouchesPart = { kind: 'pending' } | { kind: 'loaded'; touches: Touches } | { kind: 'failed' };
type PartsState = { map: MapPart; touches: TouchesPart };
type PathsState =
  | { kind: 'idle' | 'loading' | 'error' }
  | { kind: 'ready'; files: Pick<FileTrack, 'paths' | 'path' | 'born'>[] };
type Clock = { seconds: number; playing: boolean };
type ActiveBeat = { beat: Beat; elapsed: number; auto: boolean };

const SEEKED = 99;
const CLIP_SECONDS = 20;
const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);
/** A retry gets its own URL, so a preload that never settled cannot answer it. */
const retryUrl = (url: string, token: string | null) =>
  token === null ? url : `${url}&retry=${token}`;
const REDUCED = '(prefers-reduced-motion: reduce)';
const PHONE = '(max-width: 640px)';

function subscribeReduced(changed: () => void) {
  const preference = window.matchMedia(REDUCED);
  preference.addEventListener('change', changed);
  return () => preference.removeEventListener('change', changed);
}
function subscribePhone(changed: () => void) {
  const preference = window.matchMedia(PHONE);
  preference.addEventListener('change', changed);
  return () => preference.removeEventListener('change', changed);
}

async function openPart(url: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const idle = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    idle.abort();
  }, PART_IDLE_MS);
  const combined = AbortSignal.any([signal, idle.signal]);
  try {
    const response = await fetch(url, { signal: combined, priority: 'low' });
    if (!response.ok || !response.body)
      throw new Error(`The snapshot part returned ${response.status}.`);
    return response.body;
  } catch (error) {
    if (timedOut) throw new Error('The snapshot part stopped arriving.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readPart(url: string, signal: AbortSignal): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await openPart(url, signal)).arrayBuffer());
}

/** Where the clock starts before the map arrives. It reads only props, so hydration matches. */
function storyClock(story: Story, timePin: string | null): Clock {
  const { eras, coverage } = story;
  if (timePin !== null && /^\d+$/.test(timePin))
    return {
      seconds: secondsAtCommit(eras, clamp(Number(timePin), 0, coverage.analyzedCommits - 1)),
      playing: false,
    };
  const era = selectedEraForPin(eras, timePin);
  return { seconds: era === null ? 0 : secondsAtCommit(eras, eras[era].start), playing: false };
}

type Progress = { received: number; total: number | null };
type ProgressPart = 'map' | 'touches';

/** Progress lives outside React state, so a byte count re-renders only the caption's progress line. */
function progressStore() {
  let value: Record<ProgressPart, Progress> = {
    map: { received: 0, total: null },
    touches: { received: 0, total: null },
  };
  const listeners = new Set<() => void>();
  return {
    get: (part: ProgressPart) => value[part],
    /** A retry restarts a part, but the caption's numbers may only stay level or climb. */
    set(part: ProgressPart, next: Progress) {
      const current = value[part];
      const total = next.total === null ? current.total : Math.max(current.total ?? 0, next.total);
      const received = Math.max(current.received, next.received);
      const progress = {
        received: total === null ? received : Math.min(received, total),
        total,
      };
      if (progress.received === current.received && progress.total === current.total) return;
      value = { ...value, [part]: progress };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
type ProgressStore = ReturnType<typeof progressStore>;

function MapProgress({ store, part }: { store: ProgressStore; part: ProgressPart }) {
  const { received, total } = useSyncExternalStore(
    store.subscribe,
    () => store.get(part),
    () => store.get(part),
  );
  const label = part === 'map' ? 'map' : 'flashes';
  return (
    <span>
      {total ? `${label} ${megabytes(received)} of ${megabytes(total)} mb` : `loading the ${label}`}
    </span>
  );
}

export function RepositoryViewer({
  story,
  timePin,
  debug = false,
}: {
  story: Story;
  timePin: string | null;
  debug?: boolean;
}) {
  preload(story.parts.map, { as: 'fetch', crossOrigin: 'anonymous', fetchPriority: 'low' });
  const [state, setState] = useState<PartsState>({
    map: { kind: 'pending' },
    touches: { kind: 'pending' },
  });
  const [attempt, setAttempt] = useState(0);
  const [progress] = useState(progressStore);
  const restController = useRef<AbortController | null>(null);
  const touchRetry = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const shown = { map: 0, touches: 0 };
    const token = attempt > 0 ? `m${attempt}` : null;
    const { map: mapPart, touches: touchesPart } = loadSnapshotParts(
      (url) => openPart(url, controller.signal),
      {
        map: retryUrl(story.parts.map, token),
        touches: retryUrl(story.parts.touches, token),
      },
      {
        header(extent) {
          progress.set('map', { received: 0, total: extent.bytes });
          progress.set('touches', { received: 0, total: touchesBytes(extent) });
        },
        progress(part, bytes, partTotal) {
          if (bytes - shown[part] < 65_536 && bytes !== partTotal) return;
          shown[part] = bytes;
          progress.set(part, { received: bytes, total: partTotal });
        },
        map(map) {
          if (map.commits !== story.coverage.analyzedCommits)
            throw new Error('The map does not match this snapshot.');
          const commits = Array.from(map.times, (time) => ({ time }));
          setState((current) => ({ ...current, map: { kind: 'loaded', map, commits } }));
        },
      },
    );
    mapPart.catch(() => {
      if (!controller.signal.aborted)
        setState((current) => ({ ...current, map: { kind: 'failed' } }));
    });
    touchesPart
      .then((touches) => {
        if (!controller.signal.aborted)
          setState((current) => ({ ...current, touches: { kind: 'loaded', touches } }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState((current) => ({ ...current, touches: { kind: 'failed' } }));
      });
    return () => controller.abort();
  }, [story.parts.map, story.parts.touches, story.coverage.analyzedCommits, attempt, progress]);
  useEffect(() => () => restController.current?.abort(), []);
  const retry = useCallback(() => {
    restController.current?.abort();
    setState({ map: { kind: 'pending' }, touches: { kind: 'pending' } });
    setAttempt((value) => value + 1);
  }, []);
  const mapPart = state.map;
  const retryTouches = useCallback(() => {
    if (mapPart.kind !== 'loaded') return;
    restController.current?.abort();
    const controller = new AbortController();
    restController.current = controller;
    setState((current) => ({ ...current, touches: { kind: 'pending' } }));
    retrySnapshotTouches(
      (url) => openPart(url, controller.signal),
      retryUrl(story.parts.touches, `t${++touchRetry.current}`),
      mapPart.map,
      (received, total) => progress.set('touches', { received, total }),
    )
      .then((touches) => {
        if (!controller.signal.aborted)
          setState((current) => ({ ...current, touches: { kind: 'loaded', touches } }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState((current) => ({ ...current, touches: { kind: 'failed' } }));
      });
  }, [mapPart, progress, story.parts.touches]);
  const loaded =
    state.map.kind === 'loaded'
      ? {
          map: state.map.map,
          commits: state.map.commits,
          touches: state.touches.kind === 'loaded' ? state.touches.touches : null,
        }
      : null;
  return (
    <SnapshotViewer
      story={story}
      timePin={timePin}
      loaded={loaded}
      debug={debug}
      failure={
        state.map.kind === 'failed' && (
          <p className="stage-note" role="alert">
            the map could not load. the chapters below still read.{' '}
            <button type="button" className="text-button" onClick={retry}>
              try again
            </button>
          </p>
        )
      }
      status={
        state.map.kind === 'failed' ? (
          'map failed'
        ) : state.touches.kind === 'failed' && loaded ? (
          <>
            flashes failed{' '}
            <button type="button" className="text-button" onClick={retryTouches}>
              try again
            </button>
          </>
        ) : state.map.kind === 'pending' ? (
          <MapProgress store={progress} part="map" />
        ) : state.touches.kind === 'pending' ? (
          <MapProgress store={progress} part="touches" />
        ) : null
      }
    />
  );
}

const Heading = memo(function Heading({
  meta,
}: {
  meta: Pick<Story, 'repository' | 'coverage' | 'startTime' | 'endTime' | 'generatedAt'>;
}) {
  const { repository, coverage } = meta;
  return (
    <>
      <h1 className="sr-only">{repository.slug}</h1>
      <p className="lede">
        {repository.description && (
          <>
            <bdi>{repository.description.replace(/\.?\s*$/, '.')}</bdi>{' '}
          </>
        )}
        {formatNumber(coverage.analyzedCommits)} commits on{' '}
        <span className="cased">{repository.branch}</span> from {formatDate(meta.startTime)} to{' '}
        {formatDate(meta.endTime)}, and {formatNumber(coverage.displayedFiles)} files. A point is a
        file, and files that change together sit together.
      </p>
      <p className="repository-meta tone-faint">
        <ExternalLink
          className="faint-link underlined"
          href={`https://github.com/${repository.slug}`}
        >
          github.com/<span className="cased">{repository.slug}</span>{' '}
          <span aria-hidden="true">↗</span>
        </ExternalLink>{' '}
        · snapshot of{' '}
        {new Date(meta.generatedAt).toLocaleDateString('en', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })}
      </p>
    </>
  );
});

function SnapshotViewer({
  story,
  timePin,
  loaded,
  debug,
  failure,
  status,
}: {
  story: Story;
  timePin: string | null;
  loaded: Loaded | null;
  debug: boolean;
  /** Shown in the empty stage when the map file cannot load. */
  failure: ReactNode;
  status: ReactNode;
}) {
  const { eras, repository } = story;
  const count = story.coverage.analyzedCommits;
  const map = loaded?.map ?? null;
  const commits = loaded?.commits ?? null;
  const touches = loaded?.touches ?? null;
  const sceneRef = useRef<SceneHandle | null>(null);
  const loopRef = useRef<ReturnType<typeof createRenderLoop> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chaptersButtonRef = useRef<HTMLButtonElement>(null);
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const visibleRef = useRef(true);
  const stillRef = useRef(SEEKED);
  const touchedRef = useRef(false);
  const beatRef = useRef<ActiveBeat | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSeq = useRef(0);
  const lastChapterRef = useRef(-1);
  const pinnedRef = useRef<number | null>(null);
  const reduced = useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
  const phone = useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
  const [clock, setClock] = useState<Clock>(() => storyClock(story, timePin));
  const clockRef = useRef(clock);
  const [stage, setStage] = useState<StageState>('loading');
  const [hovered, setHovered] = useState<number | null>(null);
  const [found, setFound] = useState<number | null>(null);
  const [paths, setPaths] = useState<PathsState>({ kind: 'idle' });
  const [finding, setFinding] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? !phone;
  const [flash, setFlash] = useState<{ title: string; id: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [storyVisible, setStoryVisible] = useState(false);
  const [stack, setStack] = useState(112);
  const cursor = commitAtSeconds(eras, count, clock.seconds);
  const chapter = eraIndexAt(eras, cursor);
  const view = useMemo(() => chapterView(eras[chapter]), [eras, chapter]);
  const beats = useMemo(
    () => buildBeats(eras, commits ?? [], map?.beatTicks ?? null),
    [eras, commits, map],
  );
  const touchIndex = useMemo(
    () => (touches && map ? invertTouches(touches, map.commits) : null),
    [touches, map],
  );
  const activity = useMemo(() => (touchIndex ? touchActivity(touchIndex) : null), [touchIndex]);
  let alive = 0;
  if (map)
    for (let file = 0; file < map.files; file++)
      if (map.born[file] <= cursor && cursor < map.died[file]) alive++;

  const frameBox = useCallback((scaleFor: (box: FrameBox) => number): FrameBox | null => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const chrome = rootRef.current?.querySelector('.theater-chrome')?.getBoundingClientRect();
    const card = rootRef.current?.querySelector('.chapter-card')?.getBoundingClientRect();
    const bottomTop = bottomRef.current?.getBoundingClientRect().top ?? height - 112;
    const inset = 6;
    const left = 16;
    const right = width - 16;
    const top = Math.ceil(chrome?.bottom ?? 56);
    const bottom = Math.floor(Math.min(height, bottomTop) - inset);
    const fade = { top, bottom: Math.floor(Math.min(height, bottomTop)) };
    if (!card || card.width === 0 || card.height === 0)
      return { left, top, right, bottom: Math.max(top + 1, bottom), fade };
    const rightOfCard: FrameBox = {
      left: Math.min(right - 1, Math.ceil(card.right + inset)),
      top,
      right,
      bottom,
      fade,
    };
    const aboveCard: FrameBox = {
      left,
      top,
      right,
      bottom: Math.max(top + 1, Math.min(bottom, Math.floor(card.top - inset))),
      fade,
    };
    // The box that frames the percentile core largest wins, not the one with the most area: a wide
    // short strip can frame a tall cloud worse than the narrow area beside the card.
    const candidates = [rightOfCard, aboveCard];
    let free = candidates[0];
    let best = scaleFor(free);
    for (const candidate of candidates.slice(1)) {
      const scale = scaleFor(candidate);
      if (scale > best) {
        best = scale;
        free = candidate;
      }
    }
    if (best <= 0 || free.right - free.left < 120 || free.bottom - free.top < 120)
      return { left, top, right, bottom: Math.max(top + 1, bottom), fade };
    return free;
  }, []);

  const clearBeat = useCallback(() => {
    beatRef.current = null;
    sceneRef.current?.setBeat(null);
  }, []);
  const changeClock = useCallback((next: Clock) => {
    if (exportRef.current) return;
    touchedRef.current = true;
    clockRef.current = next;
    setClock(next);
    loopRef.current?.invalidate();
  }, []);
  const triggerBeat = useCallback(
    (beat: Beat, auto: boolean) => {
      beatRef.current = { beat, elapsed: 0, auto };
      sceneRef.current?.setBeat({
        files: touchIndex ? (touchedAt(touchIndex, beat.tick) ?? null) : null,
        sha: beat.sha,
        subject: beat.subject,
      });
      loopRef.current?.invalidate();
    },
    [touchIndex],
  );
  const writePin = useCallback(
    (commit: number) => {
      if (pinnedRef.current === commit) return;
      window.history.replaceState(
        window.history.state,
        '',
        pinnedUrl({
          origin: window.location.origin,
          slug: story.repository.slug,
          snapshotId: story.id,
          cursor: commit,
        }),
      );
      pinnedRef.current = commit;
    },
    [story],
  );
  const pinCurrent = useCallback(() => {
    if (exportRef.current) return;
    writePin(commitAtSeconds(eras, count, clockRef.current.seconds));
  }, [count, eras, writePin]);
  const seek = useCallback(
    (commit: number, playing: boolean, pin = true) => {
      if (exportRef.current) return;
      clearBeat();
      stillRef.current = SEEKED;
      changeClock({ seconds: secondsAtCommit(eras, commit), playing });
      if (!playing && pin) writePin(commit);
    },
    [eras, changeClock, clearBeat, writePin],
  );

  useEffect(() => {
    if (!commits) return;
    const pin = resolveTimePin(new URLSearchParams(window.location.search).get('t'), commits);
    const motion = !window.matchMedia(REDUCED).matches;
    const current = clockRef.current;
    const next = touchedRef.current
      ? { seconds: current.seconds, playing: motion }
      : pin !== null
        ? { seconds: secondsAtCommit(eras, pin), playing: false }
        : { seconds: motion ? 0 : TOUR_SECONDS, playing: motion };
    stillRef.current = SEEKED;
    clockRef.current = next;
    setClock(next);
    loopRef.current?.invalidate();
  }, [commits, eras]);

  useEffect(() => {
    if (paths.kind !== 'loading' || !map) return;
    const controller = new AbortController();
    readPart(story.parts.paths, controller.signal)
      .then((bytes) => {
        const files = unpackPaths(bytes, map.files).map((track, file) => ({
          paths: track,
          path: track[track.length - 1][1],
          born: map.born[file],
        }));
        setPaths({ kind: 'ready', files });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPaths({ kind: 'error' });
      });
    return () => controller.abort();
  }, [paths.kind, map, story.parts.paths]);
  const wantPaths = useCallback(
    () =>
      setPaths((current) =>
        current.kind === 'idle' || current.kind === 'error' ? { kind: 'loading' } : current,
      ),
    [],
  );
  useEffect(() => {
    const preference = window.matchMedia(REDUCED);
    const changed = () => {
      if (preference.matches) changeClock({ seconds: TOUR_SECONDS, playing: false });
    };
    preference.addEventListener('change', changed);
    return () => preference.removeEventListener('change', changed);
  }, [changeClock]);

  useEffect(() => {
    if (!commits) return;
    const popped = () => {
      const pin = resolveTimePin(new URLSearchParams(window.location.search).get('t'), commits);
      pinnedRef.current = pin;
      if (pin === null) return;
      stillRef.current = SEEKED;
      changeClock({ seconds: secondsAtCommit(eras, pin), playing: false });
    };
    window.addEventListener('popstate', popped);
    return () => window.removeEventListener('popstate', popped);
  }, [commits, eras, changeClock]);

  useEffect(() => {
    const element = rootRef.current?.querySelector('.stage');
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      visibleRef.current = entry.isIntersecting;
      loopRef.current?.invalidate();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = rootRef.current?.querySelector('.repository-story');
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setStoryVisible(entry.isIntersecting);
      },
      { rootMargin: '0px 0px -8px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = bottomRef.current;
    const card = rootRef.current?.querySelector('.chapter-card');
    if (!element) return;
    const measure = () => {
      setStack(element.offsetHeight);
      sceneRef.current?.reframeNow();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (card) observer.observe(card);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (lastChapterRef.current === chapter) return;
    lastChapterRef.current = chapter;
    const id = ++flashSeq.current;
    setFlash({ title: view.title, id });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1400);
  }, [chapter, view.title]);

  useEffect(() => {
    const active = beatRef.current;
    if (!active || !touchIndex) return;
    sceneRef.current?.setBeat({
      files: touchedAt(touchIndex, active.beat.tick) ?? null,
      sha: active.beat.sha,
      subject: active.beat.subject,
    });
  }, [touchIndex]);

  useEffect(() => {
    let published = 0;
    const loop = createRenderLoop((elapsed, now) => {
      if (exportRef.current) return false;
      let current = clockRef.current;
      const before = commitAtSeconds(eras, count, current.seconds);
      const active = beatRef.current;
      const step = active?.auto ? elapsed * beatSpeed(active.elapsed) : elapsed;
      if (current.playing) {
        const seconds = Math.min(TOUR_SECONDS, current.seconds + step);
        current = { seconds, playing: seconds < TOUR_SECONDS };
        clockRef.current = current;
        if (!current.playing || now - published > 90) {
          setClock(current);
          published = now;
        }
      }
      const position = commitAtSeconds(eras, count, current.seconds);
      stillRef.current = position !== before ? 0 : stillRef.current + elapsed;
      if (current.playing && position > before) {
        const crossed = beats.filter((beat) => beat.tick > before && beat.tick <= position);
        if (crossed.length > 0) triggerBeat(crossed[crossed.length - 1], true);
      }
      let weight = 0;
      let beatElapsed = 0;
      const running = beatRef.current;
      if (running) {
        running.elapsed += elapsed;
        if (running.elapsed >= ENVELOPE_SECONDS) {
          beatRef.current = null;
          sceneRef.current?.setBeat(null);
        } else {
          weight = reduced ? 1 : envelope(running.elapsed);
          beatElapsed = running.elapsed;
        }
      }
      const easing =
        visibleRef.current &&
        (sceneRef.current?.render(
          {
            cursor: position,
            still: stillRef.current,
            playing: current.playing,
            beatWeight: weight,
            beatElapsed,
          },
          elapsed,
        ) ??
          false);
      return current.playing || easing || stillRef.current < 1.2 || beatRef.current !== null;
    });
    loopRef.current = loop;
    loop.invalidate();
    return () => {
      loop.dispose();
      loopRef.current = null;
    };
  }, [eras, count, beats, triggerBeat, reduced]);

  useEffect(() => {
    sceneRef.current?.mark(found);
  }, [found, stage]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      exportRef.current?.abort();
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const selectChapter = useCallback(
    (index: number, scroll = false) => {
      clearBeat();
      seek(eras[index].start, !reduced && map !== null);
      if (scroll) window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    },
    [clearBeat, eras, reduced, map, seek],
  );
  const goToBeat = useCallback(
    (direction: 1 | -1) => {
      const current = commitAtSeconds(eras, count, clockRef.current.seconds);
      const beat = direction > 0 ? nextBeat(beats, current) : previousBeat(beats, current);
      if (!beat) return;
      seek(beat.tick, false);
      triggerBeat(beat, false);
    },
    [beats, count, eras, seek, triggerBeat],
  );
  const goToChapter = useCallback(
    (direction: 1 | -1) => {
      const current = chapterAtSeconds(eras, clockRef.current.seconds);
      const next = clamp(current + direction, 0, eras.length - 1);
      clearBeat();
      seek(eras[next].start, clockRef.current.playing && !reduced && map !== null);
    },
    [clearBeat, eras, reduced, map, seek],
  );

  const togglePlay = useCallback(() => {
    const { seconds, playing } = clockRef.current;
    if (playing) {
      changeClock({ seconds, playing: false });
      writePin(commitAtSeconds(eras, count, seconds));
    } else {
      clearBeat();
      changeClock({ seconds: seconds >= TOUR_SECONDS ? 0 : seconds, playing: true });
    }
  }, [changeClock, clearBeat, count, eras, writePin]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable ||
        event.target instanceof HTMLDialogElement ||
        document.querySelector('dialog[open]')
      )
        return;
      if (event.key === ' ' || event.code === 'Space') {
        if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return;
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToBeat(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToBeat(-1);
      } else if (event.key === ']' || event.key === '}') {
        event.preventDefault();
        goToChapter(1);
      } else if (event.key === '[' || event.key === '{') {
        event.preventDefault();
        goToChapter(-1);
      }
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [goToBeat, goToChapter, togglePlay]);

  const recordRef = useRef<() => Promise<void>>(async () => {});
  const exportClip = useCallback(() => void recordRef.current(), []);

  async function record() {
    if (exportRef.current) return;
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    const scene = sceneRef.current;
    if (!map) return;
    const mimeType =
      typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream
        ? undefined
        : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(
            (type) => MediaRecorder.isTypeSupported(type),
          );
    if (!scene || !mimeType) {
      setNotice('This browser cannot record the map. The address bar links to this moment.');
      return;
    }
    const controller = new AbortController();
    exportRef.current = controller;
    const original = clockRef.current;
    const restoreCamera = scene.holdCamera();
    const reducedBefore = window.matchMedia(REDUCED).matches;
    loopRef.current?.setEnabled(false);
    setExporting(true);
    setNotice(`Recording a ${CLIP_SECONDS}-second clip. Keep this tab visible.`);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser could not prepare the recording canvas.');
      const palette = readPalette();
      const style = getComputedStyle(rootRef.current ?? document.body);
      const mono = getComputedStyle(document.body).fontFamily;
      const sans = style.getPropertyValue('--font-geist-sans') || 'sans-serif';
      const pixel = style.getPropertyValue('--font-geist-pixel-square') || mono;
      const startSeconds = Math.min(original.seconds, TOUR_SECONDS - CLIP_SECONDS);
      let previous = -1;
      const blob = await recordCanvas({
        canvas,
        mimeType,
        signal: controller.signal,
        draw(seconds) {
          const index = commitAtSeconds(eras, count, startSeconds + seconds);
          const era = eras[eraIndexAt(eras, index)];
          scene.render(
            {
              cursor: index,
              still: 0,
              playing: true,
              beatWeight: 0,
              beatElapsed: 0,
            },
            previous < 0 ? 0 : seconds - previous,
          );
          previous = seconds;
          context.fillStyle = css(palette.bg);
          context.fillRect(0, 0, 1280, 720);
          const scale = Math.min(1280 / scene.canvas.width, 560 / scene.canvas.height);
          const width = scene.canvas.width * scale;
          const height = scene.canvas.height * scale;
          const left = (1280 - width) / 2;
          context.drawImage(scene.canvas, left, 40, width, height);
          const ratio = scene.canvas.width / scene.canvas.clientWidth || 1;
          context.font = `${11 * ratio * scale}px ${mono}`;
          context.textBaseline = 'middle';
          for (const label of scene.labels()) {
            const x = left + label.x * ratio * scale;
            const y = 40 + (label.y + 9) * ratio * scale;
            const w = context.measureText(label.text).width + 8 * ratio * scale;
            context.fillStyle = css(palette.bg);
            context.fillRect(x, y - 9 * ratio * scale, w, 18 * ratio * scale);
            context.fillStyle = css(palette.faint);
            context.fillText(label.text, x + 4 * ratio * scale, y);
          }
          context.textBaseline = 'alphabetic';
          context.fillStyle = css(palette.ink);
          context.font = `28px ${pixel}`;
          context.fillText('lore', 40, 56);
          context.fillStyle = css(palette.faint);
          context.font = `17px ${mono}`;
          context.fillText(story.repository.slug, 120, 54);
          context.fillText(
            `${formatDate(map.times[index])} · chapter ${era.id + 1} of ${eras.length}`.toLowerCase(),
            40,
            640,
          );
          context.fillStyle = css(palette.ink);
          context.font = `600 30px ${sans}`;
          context.fillText(era.title.toLowerCase(), 40, 684, 1200);
        },
      });
      if (controller.signal.aborted || !mountedRef.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `lore-${story.repository.name}-${cursor}.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice('Your clip is ready. Its quality and frame rate depend on your browser.');
      noticeTimer.current = setTimeout(() => {
        if (mountedRef.current) setNotice('');
      }, 6000);
    } catch (error) {
      if (mountedRef.current)
        setNotice(error instanceof Error ? error.message : 'Recording failed.');
    } finally {
      exportRef.current = null;
      if (mountedRef.current) {
        clockRef.current =
          !reducedBefore && window.matchMedia(REDUCED).matches
            ? { seconds: TOUR_SECONDS, playing: false }
            : original;
        setClock(clockRef.current);
        restoreCamera();
        stillRef.current = SEEKED;
        loopRef.current?.setEnabled(true);
        setExporting(false);
      }
    }
  }

  useEffect(() => {
    recordRef.current = record;
  });

  useEffect(() => {
    if (!debug) return;
    const hook = {
      snapshot: () => ({ id: story.id, slug: story.repository.slug }),
      state() {
        const tick = commitAtSeconds(eras, count, clockRef.current.seconds);
        const active = beatRef.current;
        return {
          tick,
          chapter: eraIndexAt(eras, tick) + 1,
          chapters: eras.length,
          playing: clockRef.current.playing,
          beat: active?.beat.sha ?? null,
          beatWeight: active ? envelope(active.elapsed) : 0,
          files: sceneRef.current?.beatFiles() ?? [],
        };
      },
      beats: () =>
        beats.map((beat) => ({
          tick: beat.tick,
          sha: beat.sha,
          subject: beat.subject,
          era: beat.era,
        })),
      chapters: () => eras.map((era) => ({ start: era.start, title: era.title })),
      touched: (tick: number) => (touchIndex ? Array.from(touchedAt(touchIndex, tick) ?? []) : []),
      flare: () => sceneRef.current?.beatFiles() ?? [],
      camera: () => sceneRef.current?.camera() ?? null,
      point: (file: number) => sceneRef.current?.point(file) ?? null,
      alive: () => sceneRef.current?.alivePoints() ?? [],
      frameTimes(ms: number) {
        return new Promise<number[]>((resolve) => {
          const out: number[] = [];
          const start = performance.now();
          let previous = start;
          function step(now: number) {
            out.push(now - previous);
            previous = now;
            if (now - start < ms) requestAnimationFrame(step);
            else resolve(out);
          }
          requestAnimationFrame(step);
        });
      },
    };
    (window as unknown as { __lore?: typeof hook }).__lore = hook;
    return () => {
      delete (window as unknown as { __lore?: typeof hook }).__lore;
    };
  }, [debug, beats, touchIndex, count, eras, story]);

  return (
    <div
      ref={rootRef}
      className={`repository ${Geist.variable}${storyVisible ? ' story-visible' : ''}`}
      style={{ '--stack': `${stack}px` } as CSSProperties}
    >
      <Stage
        note={failure}
        map={map}
        touches={touches}
        eras={eras}
        reducedMotion={reduced}
        sceneRef={sceneRef}
        onState={(next) => {
          if (next === 'fallback') exportRef.current?.abort();
          if (next === 'ready') wantPaths();
          setStage(next);
          loopRef.current?.invalidate();
        }}
        onHover={(file) => {
          if (file !== null) wantPaths();
          setHovered(file);
        }}
        onZoom={setZoom}
        onInvalidate={() => loopRef.current?.invalidate()}
        frameBox={frameBox}
      />

      <header className="theater-chrome">
        <div className="brand">
          <Link href="/" className="wordmark">
            lore
          </Link>
          <span className="repo cased">{repository.slug}</span>
        </div>
        <div className="actions">
          <button
            ref={chaptersButtonRef}
            type="button"
            className="chapters-btn"
            aria-haspopup="dialog"
            aria-expanded={chaptersOpen}
            onClick={() => setChaptersOpen(true)}
          >
            chapters
          </button>
          <button
            ref={findButtonRef}
            type="button"
            className="chapters-btn"
            aria-expanded={finding}
            disabled={!map}
            onClick={() => {
              wantPaths();
              setFinding((open) => !open);
            }}
          >
            find a file
          </button>
          <button
            type="button"
            className="chapters-btn"
            disabled={stage !== 'ready' || exporting || !map}
            onClick={exportClip}
          >
            {exporting ? 'recording a clip' : 'export a clip'}
          </button>
          <nav className="site-nav" aria-label="site">
            <Link href="/#collection" className="faint-link">
              collection
            </Link>
            <Link href="/_/method" className="faint-link">
              method
            </Link>
            <Link href="/_/about" className="faint-link">
              about
            </Link>
          </nav>
        </div>
      </header>

      {flash && !failure && (
        <div key={flash.id} className="chapter-flash show" aria-hidden="true">
          <span>{flash.title}</span>
        </div>
      )}

      <ChapterCard
        chapter={view}
        beats={beats}
        cursor={cursor}
        repository={repository.slug}
        expanded={expanded}
        onToggle={() => setExpandedOverride(!expanded)}
      />

      <div className="theater-bottom" ref={bottomRef}>
        {commits ? (
          <Timeline
            commits={commits}
            eras={eras}
            cursor={cursor}
            activity={activity}
            disabled={exporting}
            onSeek={(commit) => seek(commit, false, false)}
            onSeekEnd={pinCurrent}
            onSelectChapter={(index) => selectChapter(index)}
          />
        ) : (
          <div className="timeline" aria-hidden="true" />
        )}
        <div className="map-caption">
          <span className="tline-left">
            <span className="tone-ink">
              {monthStamp(map ? map.times[cursor] : eras[chapter].startTime)}
            </span>{' '}
            · chapter {chapter + 1} of {eras.length}
          </span>
          <span className="map-path cased">
            {hovered === null
              ? null
              : paths.kind === 'ready'
                ? pathAt(paths.files[hovered], cursor)
                : paths.kind === 'error'
                  ? 'paths could not load'
                  : 'loading paths'}
          </span>
          <span className="map-status">
            {status ?? (
              <>
                <span className="tone-ink">{formatNumber(alive)}</span> files
              </>
            )}
          </span>
        </div>
        <div className="map-controls">
          <button
            type="button"
            className="text-button play"
            disabled={!map || exporting}
            onClick={togglePlay}
          >
            {clock.playing ? 'pause' : 'play'}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={!map || exporting}
            onClick={() => seek(0, !reduced)}
          >
            restart
          </button>
          <button
            type="button"
            className="text-button"
            aria-pressed={zoom > 1}
            disabled={stage !== 'ready' || exporting}
            onClick={() => sceneRef.current?.setZoom(zoom > 1 ? 1 : 2.5)}
          >
            zoom
          </button>
          <span className="hint">space play/pause · ← → commits · [ ] chapters</span>
        </div>
      </div>

      <ChaptersDialog
        open={chaptersOpen}
        eras={eras}
        current={chapter}
        onClose={() => {
          setChaptersOpen(false);
          chaptersButtonRef.current?.focus();
        }}
        onSelect={(index) => {
          selectChapter(index);
          setChaptersOpen(false);
          chaptersButtonRef.current?.focus();
        }}
      />

      {finding && commits && paths.kind === 'ready' && (
        <div className="find-panel">
          <FindFile
            files={paths.files}
            commits={commits}
            onClose={() => {
              setFinding(false);
              findButtonRef.current?.focus();
            }}
            onSelect={(file) => {
              setFound(file);
              seek(paths.files[file].born, clockRef.current.playing);
              setFinding(false);
              findButtonRef.current?.focus();
            }}
          />
        </div>
      )}
      {finding && paths.kind !== 'ready' && (
        <p className="find form-note find-panel" role="status">
          {paths.kind === 'error' ? (
            <>
              the file paths could not load.{' '}
              <button type="button" className="text-button" onClick={wantPaths}>
                try again
              </button>
            </>
          ) : (
            'loading paths'
          )}
        </p>
      )}

      {notice && (
        <p className="map-notice tone-faint" role="status">
          {notice}{' '}
          {exporting && (
            <button
              type="button"
              className="text-button"
              onClick={() => exportRef.current?.abort()}
            >
              cancel
            </button>
          )}
        </p>
      )}

      <p className="sr-only" aria-live="polite">
        chapter {chapter + 1} of {eras.length}: {view.title.toLowerCase()}
      </p>

      <div className="repository-story" id="story">
        <Heading meta={story} />
        <Chapters eras={eras} current={chapter} onSelect={(index) => selectChapter(index, true)} />
        <Chapter chapter={view} repository={repository.slug} />
      </div>
    </div>
  );
}
