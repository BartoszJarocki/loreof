import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Era } from '@/lib/schema';
import type { SnapshotMap, Touches } from '@/lib/snapshot-pack';
import type { FrameBox } from '@/viewer/framing';
import { mountScene, type SceneHandle } from '@/viewer/scene';
import { readPalette } from '@/viewer/tokens';

export type StageState = 'loading' | 'ready' | 'fallback';

/** Holds the whole viewport before the map arrives, so the chrome never moves when it mounts. */
export function Stage({
  note,
  map,
  touches,
  eras,
  reducedMotion,
  sceneRef,
  onState,
  onHover,
  onZoom,
  onInvalidate,
  frameBox,
}: {
  note: ReactNode;
  map: SnapshotMap | null;
  touches: Touches | null;
  eras: Era[];
  reducedMotion: boolean;
  sceneRef: RefObject<SceneHandle | null>;
  onState: (state: StageState) => void;
  onHover: (file: number | null) => void;
  onZoom: (zoom: number) => void;
  onInvalidate: () => void;
  frameBox: (scaleFor: (box: FrameBox) => number) => FrameBox | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<StageState>('loading');
  const [attempt, setAttempt] = useState(0);
  const callbacks = useRef({ onState, onHover, onZoom, onInvalidate, frameBox });
  const latestTouches = useRef(touches);
  useEffect(() => {
    callbacks.current = { onState, onHover, onZoom, onInvalidate, frameBox };
    latestTouches.current = touches;
  });
  useEffect(() => {
    if (touches) sceneRef.current?.setTouches(touches);
  }, [touches, sceneRef]);
  useEffect(() => {
    const element = container.current;
    if (!element || !map) return;
    let disposed = false;
    let handle: SceneHandle | null = null;
    let frame = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const report = (next: StageState) => {
      setState(next);
      callbacks.current.onState(next);
    };
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const recolor = () => handle?.setPalette(readPalette());
    scheme.addEventListener('change', recolor);
    Promise.resolve()
      .then(() => {
        if (disposed) return;
        handle = mountScene({
          container: element,
          map,
          touches: latestTouches.current,
          eras,
          palette: readPalette(),
          reducedMotion,
          onHover: (file) => callbacks.current.onHover(file),
          onZoom: (zoom) => callbacks.current.onZoom(zoom),
          onInvalidate: () => callbacks.current.onInvalidate(),
          onLost: () => {
            sceneRef.current = null;
            report('fallback');
          },
          onRestored: () => {
            sceneRef.current = handle;
            report('ready');
          },
          frameBox: (scaleFor) => callbacks.current.frameBox(scaleFor),
        });
        callbacks.current.onZoom(1);
        sceneRef.current = handle;
        report('ready');
        const settle = () => {
          if (!disposed) handle?.reframeNow();
        };
        frame = requestAnimationFrame(settle);
        timers.push(setTimeout(settle, 250), setTimeout(settle, 900));
      })
      .catch(() => {
        if (!disposed) report('fallback');
      });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      scheme.removeEventListener('change', recolor);
      handle?.dispose();
      sceneRef.current = null;
    };
  }, [map, eras, reducedMotion, sceneRef, attempt]);
  return (
    <div ref={container} className="stage" data-state={state}>
      {!map && note}
      {map && state === 'loading' && (
        <p className="stage-note" role="status">
          drawing the map
        </p>
      )}
      {state === 'fallback' && (
        <p className="stage-note">
          the map needs WebGL, which this browser can&apos;t run here. the chapters below still
          play.{' '}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setState('loading');
              setAttempt((value) => value + 1);
            }}
          >
            try again
          </button>
        </p>
      )}
    </div>
  );
}
