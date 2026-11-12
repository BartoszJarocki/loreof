import {
  BufferAttribute,
  Color,
  BufferGeometry,
  DataTexture,
  FloatType,
  OrthographicCamera,
  Points,
  RedFormat,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Era } from '@/lib/schema';
import type { SnapshotMap, Touches } from '@/lib/snapshot-pack';
import { commitsPerSecond } from './playback';
import { BEAT_ZOOM } from './beats';
import {
  frameAlive,
  frameFiles,
  stageAxes,
  turnOf,
  type FrameBox,
  type Turn,
  type View,
} from './framing';
import { packTouchTexture, touchLookupShader } from './touch-texture';
import type { Palette, Rgb } from './tokens';

export type SceneFrame = {
  cursor: number;
  /** Seconds since playback last moved the cursor. A seek sets it high, so nothing flashes. */
  still: number;
  playing: boolean;
  /** 0 to 1 from the commit moment's envelope. */
  beatWeight: number;
  /** Seconds since the commit moment began, for the expanding ring. */
  beatElapsed: number;
};
export type SceneBeat = {
  /** Null until the touches part arrives, so the label and slow-down can still play. */
  files: Uint32Array | null;
  sha: string;
  subject: string;
};
export type MapLabel = { text: string; x: number; y: number };
export type SceneHandle = {
  canvas: HTMLCanvasElement;
  /** Draws one frame and returns whether the camera is still easing toward its framing. */
  render: (frame: SceneFrame, elapsed: number) => boolean;
  setPalette: (palette: Palette) => void;
  setZoom: (zoom: number) => void;
  /** Saves the camera and returns a function that puts it back, for drawing frames off the clock. */
  holdCamera: () => () => void;
  mark: (file: number | null) => void;
  /** Adds the touch history once the touches part arrives. */
  setTouches: (touches: Touches) => void;
  /** Starts or ends a commit moment. Its flare, ring and label follow `beatWeight`. */
  setBeat: (beat: SceneBeat | null) => void;
  /** Reframes now, after the chrome or the card changes size. */
  reframeNow: () => void;
  /** The files the current commit moment marks, for the development hook. */
  beatFiles: () => number[];
  labels: () => MapLabel[];
  /** Read-only camera state for the development hook. */
  camera: () => {
    cx: number;
    cy: number;
    scale: number;
    roll: number;
    zoom: number;
  } | null;
  /** Where one file lands on screen, for the development hook. */
  point: (file: number) => { x: number; y: number } | null;
  /** Where every alive file lands on screen, for the development hook. */
  alivePoints: () => { x: number; y: number }[];
  dispose: () => void;
};

const MAX_LABELS = 6;
const LABEL_HEIGHT = 18;
const LABEL_CHAR = 6.6;
const REFRAME_SECONDS = 0.4;
const LABEL_SECONDS = 0.1;
const SWAY_SECONDS = 96;
const MAX_ZOOM = 6;
const EDGE_FADE = 6;
const CHROME_FADE = 48;
const HIDDEN = `gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return;`;

const vector = ([r, g, b]: Rgb) => new Vector3(r / 255, g / 255, b / 255);
const clear = ([r, g, b]: Rgb) => new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);

export function mountScene({
  container,
  map,
  touches,
  eras,
  palette,
  reducedMotion,
  onHover,
  onZoom,
  onInvalidate,
  onLost,
  onRestored,
  frameBox,
}: {
  container: HTMLElement;
  map: SnapshotMap;
  /** Null until the touches part arrives. The points move without flashes until then. */
  touches: Touches | null;
  eras: Era[];
  palette: Palette;
  reducedMotion: boolean;
  onHover: (file: number | null) => void;
  onZoom: (zoom: number) => void;
  onInvalidate: () => void;
  onLost: () => void;
  onRestored: () => void;
  /** The part of the stage the chrome leaves free, measured when the camera reframes. */
  frameBox?: (scaleFor: (box: FrameBox) => number) => FrameBox | null;
}): SceneHandle {
  const renderer = new WebGLRenderer({
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  const count = map.files;
  const positions = new Float32Array(map.positions.length);
  for (let index = 0; index < positions.length; index++)
    positions[index] = map.positions[index] * map.positionScale;
  const { center, fullRadius } = frameFiles(positions);
  for (let index = 0; index < positions.length; index++) positions[index] -= center[index % 3];
  const touchOffsets = new Float32Array(count);
  const touchCounts = new Float32Array(count);
  const beatMark = new Float32Array(count);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('born', new BufferAttribute(Float32Array.from(map.born), 1));
  geometry.setAttribute('died', new BufferAttribute(Float32Array.from(map.died), 1));
  geometry.setAttribute('touchOffset', new BufferAttribute(touchOffsets, 1));
  geometry.setAttribute('touchCount', new BufferAttribute(touchCounts, 1));
  geometry.setAttribute('beatMark', new BufferAttribute(beatMark, 1));
  const births = geometry.getAttribute('born').array;
  const deaths = geometry.getAttribute('died').array;
  const directoryOf = map.directory;
  const directories = map.directories.map((path) => (path === '.' ? 'root' : `${path}/`));
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const material = new ShaderMaterial({
    uniforms: {
      cursor: { value: 0 },
      rate: { value: 1 },
      still: { value: 99 },
      extent: { value: fullRadius },
      pointSize: { value: Math.max(1, Math.round(1.6 * pixelRatio)) },
      pixelRatio: { value: pixelRatio },
      edgeFade: { value: EDGE_FADE * pixelRatio },
      viewport: { value: new Vector2(1, 1) },
      bg: { value: vector(palette.bg) },
      ink: { value: vector(palette.ink) },
      tone: { value: vector(palette.value) },
      touchHistory: { value: null as DataTexture | null },
      touchTextureSize: { value: new Vector2(1, 1) },
      beatWeight: { value: 0 },
    },
    vertexShader: `${touchLookupShader}
      attribute float born;
      attribute float died;
      attribute float beatMark;
      uniform float cursor;
      uniform float rate;
      uniform float still;
      uniform float extent;
      uniform float pointSize;
      uniform float pixelRatio;
      uniform float edgeFade;
      uniform float beatWeight;
      uniform vec2 viewport;
      uniform vec3 bg;
      uniform vec3 ink;
      uniform vec3 tone;
      varying vec3 tint;
      void main() {
        if (cursor < born || cursor >= died) { ${HIDDEN} }
        float touch = lastTouchAt(cursor);
        float age = (cursor - touch) / rate + still;
        float flash = touch < 0.0 ? 0.0 : clamp(1.0 - age * 0.9, 0.0, 1.0);
        float beat = beatMark * beatWeight;
        float size = pointSize + floor(flash * 2.0 * pixelRatio + 0.5)
          + pointSize * 1.5 * beat;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 inside = (1.0 - abs(gl_Position.xy)) * 0.5 * viewport - 0.5 * size - 2.0 * pixelRatio;
        float edge = clamp(min(inside.x, inside.y) / edgeFade, 0.0, 1.0);
        if (edge <= 0.0) { ${HIDDEN} }
        float z = (modelMatrix * vec4(position, 1.0)).z;
        float depth = 0.3 + 0.55 * clamp(0.5 + z / (2.0 * extent), 0.0, 1.0);
        float lit = max(flash, beat);
        vec3 hot = mix(bg, tone, clamp(0.45 + lit, 0.0, 1.0));
        tint = mix(bg, lit > 0.02 ? hot : mix(bg, ink, depth), edge);
        if (lit > 0.02) gl_Position.z = -1.0;
        gl_PointSize = size;
      }`,
    fragmentShader: `varying vec3 tint; void main() { gl_FragColor = vec4(tint, 1.0); }`,
  });
  let touchTexture: DataTexture | null = null;
  function setTouches(next: Touches | null) {
    const packed = packTouchTexture({
      offsets: next?.offsets ?? new Uint32Array(count + 1),
      ticks: next?.ticks ?? new Uint32Array(0),
      maxTextureSize: renderer.capabilities.maxTextureSize,
    });
    const texture = new DataTexture(packed.data, packed.width, packed.height, RedFormat, FloatType);
    texture.needsUpdate = true;
    touchTexture?.dispose();
    touchTexture = texture;
    touchOffsets.set(packed.offsets);
    touchCounts.set(packed.counts);
    geometry.getAttribute('touchOffset').needsUpdate = true;
    geometry.getAttribute('touchCount').needsUpdate = true;
    material.uniforms.touchHistory.value = texture;
    material.uniforms.touchTextureSize.value.set(packed.width, packed.height);
  }
  function applyTouches(next: Touches | null) {
    try {
      setTouches(next);
    } catch {
      // A device whose textures cannot hold this history still plays the map, without flashes.
    }
  }
  try {
    if (renderer.capabilities.maxVertexTextures < 1) {
      throw new Error('This device cannot look up repository activity on the GPU.');
    }
    setTouches(null);
  } catch (error) {
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(clear(palette.bg));
  const canvas = renderer.domElement;
  container.append(canvas);
  const fade = document.createElement('div');
  fade.className = 'map-fade';
  fade.setAttribute('aria-hidden', 'true');
  container.append(fade);
  const ringLayer = document.createElement('div');
  ringLayer.className = 'map-ring-layer';
  ringLayer.setAttribute('aria-hidden', 'true');
  container.insertBefore(ringLayer, fade);
  const overlay = document.createElement('div');
  overlay.className = 'map-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const marker = document.createElement('div');
  marker.className = 'map-mark';
  marker.hidden = true;
  const plates = Array.from({ length: MAX_LABELS }, () => {
    const plate = document.createElement('span');
    plate.className = 'map-label cased';
    plate.hidden = true;
    return plate;
  });
  const ring = document.createElement('div');
  ring.className = 'map-ring';
  ring.hidden = true;
  ringLayer.append(ring);
  const beatLabel = document.createElement('div');
  beatLabel.className = 'beat-label';
  beatLabel.hidden = true;
  const beatSha = document.createElement('span');
  beatSha.className = 'beat-sha cased';
  const beatSubject = document.createElement('span');
  beatSubject.className = 'beat-subject cased';
  beatLabel.append(beatSha, beatSubject);
  overlay.append(...plates, marker, beatLabel);
  container.append(overlay);

  const points = new Points(geometry, material);
  points.frustumCulled = false;
  const scene = new Scene();
  scene.add(points);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, fullRadius * 8);
  camera.position.set(0, 0, fullRadius * 4);

  let width = 1;
  let height = 1;
  let yaw = 0.6;
  let sway = 0;
  let zoom = 1;
  let cursor = 0;
  let view: View | null = null;
  let target: View | null = null;
  let area: FrameBox | null = null;
  let reframeIn = 0;
  let labelIn = 0;
  let hovered: number | null = null;
  let marked: number | null = null;
  let placed: MapLabel[] = [];
  let beatFiles: Uint32Array | null = null;
  let beatMarks: number[] = [];
  let disposed = false;
  const minExtent = fullRadius * 0.08;
  const labelStep = Math.max(2, Math.ceil(count / 3000));

  const alive = (file: number) => births[file] <= cursor && cursor < deaths[file];
  const angle = () =>
    yaw + (reducedMotion ? 0 : 0.31 * Math.sin((sway / SWAY_SECONDS) * 2 * Math.PI));
  const axes = { u: 0, v: 0 };
  function project(file: number, turn: Turn, into: { x: number; y: number }) {
    if (!view) return into;
    const scale = view.scale * zoom;
    stageAxes(positions, file, turn, view.cx, view.cy, axes);
    into.x = width / 2 + axes.u * scale;
    into.y = height / 2 - axes.v * scale;
    return into;
  }
  function frame(box: FrameBox | null) {
    return frameAlive({
      positions,
      born: births,
      died: deaths,
      cursor,
      yaw: angle(),
      width,
      height,
      minExtent,
      roll: target?.roll ?? null,
      box,
    });
  }
  function reframe() {
    area = frameBox?.((box) => frame(box)?.scale ?? 0) ?? null;
    target = frame(area);
    if (target && !view) view = { ...target };
    const band = area?.fade;
    const top = band ? Math.max(0, band.top) : area ? Math.max(0, area.top) : 56;
    const bottom = band
      ? Math.max(0, height - band.bottom)
      : area
        ? Math.max(0, height - area.bottom)
        : 112;
    fade.style.background = `linear-gradient(to bottom, var(--bg) 0px, var(--bg) ${top}px, transparent ${top + CHROME_FADE}px), linear-gradient(to top, var(--bg) 0px, var(--bg) ${bottom}px, transparent ${bottom + CHROME_FADE}px)`;
    if (area) {
      const clip = (value: number, limit: number) =>
        Math.round(Math.max(0, Math.min(limit, value)));
      ringLayer.style.clipPath = `inset(${clip(area.top, height)}px ${clip(width - area.right, width)}px ${clip(height - area.bottom, height)}px ${clip(area.left, width)}px)`;
    }
  }
  function freeBox(): FrameBox {
    return area ?? { left: 0, top: 0, right: width, bottom: height };
  }
  function placeLabels(turn: Turn) {
    const sums = new Map<number, [number, number, number]>();
    let total = 0;
    const point = { x: 0, y: 0 };
    for (let file = 0; file < count; file += labelStep) {
      if (!alive(file)) continue;
      total++;
      project(file, turn, point);
      const sum = sums.get(directoryOf[file]);
      if (sum) {
        sum[0] += point.x;
        sum[1] += point.y;
        sum[2]++;
      } else sums.set(directoryOf[file], [point.x, point.y, 1]);
    }
    placed = [];
    const box = freeBox();
    const ranked = [...sums]
      .filter(([, sum]) => sum[2] >= total * 0.04)
      .sort((a, b) => b[1][2] - a[1][2]);
    for (const [directory, [x, y, files]] of ranked) {
      if (placed.length === MAX_LABELS) break;
      const text = directories[directory];
      const w = text.length * LABEL_CHAR + 8;
      if (w > box.right - box.left || LABEL_HEIGHT > box.bottom - box.top) continue;
      const left = Math.max(box.left, Math.min(box.right - w, x / files - w / 2));
      const top = Math.max(
        box.top,
        Math.min(box.bottom - LABEL_HEIGHT, y / files - LABEL_HEIGHT / 2),
      );
      const overlaps = placed.some(
        (label) =>
          left < label.x + label.text.length * LABEL_CHAR + 12 &&
          label.x < left + w + 4 &&
          Math.abs(label.y - top) < LABEL_HEIGHT + 2,
      );
      if (!overlaps) placed.push({ text, x: left, y: top });
    }
    plates.forEach((plate, index) => {
      const label = placed[index];
      if (plate.hidden !== !label) plate.hidden = !label;
      if (!label) return;
      if (plate.textContent !== label.text) plate.textContent = label.text;
      const transform = `translate(${Math.round(label.x)}px, ${Math.round(label.y)}px)`;
      if (plate.style.transform !== transform) plate.style.transform = transform;
    });
  }
  function placeMarker(turn: Turn) {
    const file = marked ?? hovered;
    marker.hidden = file === null || !alive(file) || !view;
    if (file === null || marker.hidden) return;
    const { x, y } = project(file, turn, { x: 0, y: 0 });
    marker.style.transform = `translate(${x - 6}px, ${y - 6}px)`;
  }
  function nearest(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (!view) return null;
    const turn = turnOf(angle(), view.roll);
    const point = { x: 0, y: 0 };
    let best: number | null = null;
    let distance = 81;
    for (let file = 0; file < count; file++) {
      if (!alive(file)) continue;
      project(file, turn, point);
      const d = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (d < distance) {
        distance = d;
        best = file;
      }
    }
    return best;
  }
  function hover(file: number | null) {
    if (file === hovered) return;
    hovered = file;
    onHover(file);
    onInvalidate();
  }

  function beatCentroid(turn: Turn): { across: number; up: number } | null {
    if (!beatFiles || beatFiles.length === 0) return null;
    let across = 0;
    let up = 0;
    let aliveCount = 0;
    for (const file of beatFiles) {
      if (!alive(file)) continue;
      across += positions[file * 3] * turn.cos + positions[file * 3 + 2] * turn.sin;
      up += positions[file * 3 + 1];
      aliveCount++;
    }
    return aliveCount ? { across: across / aliveCount, up: up / aliveCount } : null;
  }

  /** The flared files' screen centroid and the radius that encloses their 90th percentile. */
  function flareRing(turn: Turn): { x: number; y: number; radius: number } | null {
    if (!beatFiles || beatFiles.length === 0 || !view) return null;
    const point = { x: 0, y: 0 };
    const xs: number[] = [];
    const ys: number[] = [];
    let sumX = 0;
    let sumY = 0;
    for (const file of beatFiles) {
      if (!alive(file)) continue;
      project(file, turn, point);
      xs.push(point.x);
      ys.push(point.y);
      sumX += point.x;
      sumY += point.y;
    }
    if (xs.length === 0) return null;
    const x = sumX / xs.length;
    const y = sumY / ys.length;
    const spread = xs.map((value, index) => Math.hypot(value - x, ys[index] - y));
    spread.sort((a, b) => a - b);
    return { x, y, radius: spread[Math.min(spread.length - 1, Math.floor(spread.length * 0.9))] };
  }

  function placeBeat(turn: Turn, weight: number) {
    if (!beatFiles && beatLabel.hidden) return;
    const centroid = beatCentroid(turn);
    let x = width / 2;
    let y = height / 2;
    let placedAtCentroid = false;
    if (centroid && view) {
      const scale = view.scale * zoom;
      const across = centroid.across - view.cx;
      const up = centroid.up - view.cy;
      const u = across * turn.rollCos + up * turn.rollSin;
      const v = up * turn.rollCos - across * turn.rollSin;
      x = width / 2 + u * scale;
      y = height / 2 - v * scale;
      placedAtCentroid = true;
    }
    if (!beatLabel.hidden) {
      const w = beatLabel.offsetWidth || 160;
      const h = beatLabel.offsetHeight || 50;
      const left = Math.max(16, Math.min(width - w - 16, x + 20));
      const top = Math.max(64, Math.min(height - h - 160, y - h / 2));
      beatLabel.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
      beatLabel.style.opacity = String(Math.min(1, weight * 2.2));
    }
    if (reducedMotion || !placedAtCentroid || weight <= 0.02) {
      if (!ring.hidden) ring.hidden = true;
      return;
    }
    // The ring rides the files' screen centroid every frame and is fixed to their 90th percentile,
    // so the camera pan and zoom carry it with them instead of leaving it behind. Its radius is
    // capped so a spread-out commit cannot draw an arc across the chrome, the timeline or the card.
    const mark = flareRing(turn);
    if (!mark) {
      ring.hidden = true;
      return;
    }
    const box = freeBox();
    const room = Math.max(2, Math.min(box.right - box.left, box.bottom - box.top) - 8);
    const radius = Math.max(
      1,
      Math.min(mark.radius, Math.max(24, 0.18 * Math.min(width, height)), room / 2),
    );
    const size = Math.max(8, radius * 2 + 8);
    const half = size / 2;
    const ringX = Math.max(box.left + half, Math.min(box.right - half, mark.x));
    const ringY = Math.max(box.top + half, Math.min(box.bottom - half, mark.y));
    ring.hidden = false;
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;
    ring.style.transform = `translate3d(${(ringX - half).toFixed(1)}px, ${(ringY - half).toFixed(1)}px, 0)`;
    ring.style.opacity = String(weight);
  }

  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; yaw: number; moved: boolean } | null = null;
  let pinch: { distance: number; zoom: number } | null = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  function setZoom(next: number) {
    zoom = Math.max(1, Math.min(MAX_ZOOM, next));
    onZoom(zoom);
    onInvalidate();
  }
  function pointerDown(event: PointerEvent) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      drag = null;
      pinch = { distance: spread(), zoom };
    } else if (pointers.size === 1)
      drag = { x: event.clientX, y: event.clientY, yaw, moved: false };
  }
  function pointerMove(event: PointerEvent) {
    if (pointers.has(event.pointerId))
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      setZoom((pinch.zoom * spread()) / Math.max(1, pinch.distance));
      return;
    }
    if (drag) {
      const dx = event.clientX - drag.x;
      if (Math.abs(dx) + Math.abs(event.clientY - drag.y) > 5) drag.moved = true;
      if (drag.moved) {
        yaw = drag.yaw + dx / 240;
        onInvalidate();
      }
      return;
    }
    if (event.pointerType === 'mouse') hover(nearest(event.clientX, event.clientY));
  }
  function pointerUp(event: PointerEvent) {
    if (drag && !drag.moved && event.pointerType !== 'mouse' && event.type === 'pointerup')
      hover(nearest(event.clientX, event.clientY));
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
  }
  function pointerLeave(event: PointerEvent) {
    pointerUp(event);
    if (event.pointerType === 'mouse') hover(null);
  }
  function lost(event: Event) {
    event.preventDefault();
    onLost();
  }
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('pointerleave', pointerLeave);
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const observer = new ResizeObserver(() => {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    material.uniforms.viewport.value.set(width * pixelRatio, height * pixelRatio);
    view = null;
    target = null;
    labelIn = 0;
    reframe();
    onInvalidate();
  });
  observer.observe(container);
  if (touches) applyTouches(touches);

  return {
    canvas,
    render(frame, elapsed) {
      if (disposed) return false;
      const jumped = frame.cursor !== cursor && frame.still > 1;
      cursor = frame.cursor;
      if (frame.playing) sway += elapsed;
      reframeIn -= elapsed;
      if (reframeIn <= 0 || jumped || !target) {
        reframe();
        reframeIn = REFRAME_SECONDS;
      }
      const a = angle();
      let turn = turnOf(a, view?.roll ?? 0);
      const centroid = frame.beatWeight > 0 ? beatCentroid(turn) : null;
      let easing = false;
      if (view && target) {
        let targetX = target.cx;
        let targetY = target.cy;
        let targetScale = target.scale;
        if (frame.beatWeight > 0 && !reducedMotion) {
          targetScale *= 1 + BEAT_ZOOM * frame.beatWeight;
          if (centroid) {
            const freeU = area ? (area.left + area.right) / 2 - width / 2 : 0;
            const freeV = area ? (area.top + area.bottom) / 2 - height / 2 : 0;
            const panScale = targetScale * zoom;
            const freeCos = Math.cos(target.roll);
            const freeSin = Math.sin(target.roll);
            const beatX = centroid.across - (freeU * freeCos + freeV * freeSin) / panScale;
            const beatY = centroid.up - (freeU * freeSin - freeV * freeCos) / panScale;
            targetX += (beatX - targetX) * frame.beatWeight;
            targetY += (beatY - targetY) * frame.beatWeight;
          }
        }
        const k = reducedMotion || jumped ? 1 : 1 - Math.exp(-elapsed * 4.2);
        view.cx += (targetX - view.cx) * k;
        view.cy += (targetY - view.cy) * k;
        view.scale += (targetScale - view.scale) * k;
        view.roll += (target.roll - view.roll) * Math.min(1, 2 * k);
        easing =
          Math.abs(targetScale - view.scale) / targetScale > 0.002 ||
          Math.abs(target.roll - view.roll) > 0.002 ||
          Math.abs(targetX - view.cx) > 0.5 ||
          Math.abs(targetY - view.cy) > 0.5;
      }
      points.rotation.y = a;
      if (view) {
        const halfWidth = width / 2 / (view.scale * zoom);
        const halfHeight = height / 2 / (view.scale * zoom);
        camera.position.set(view.cx, view.cy, fullRadius * 4);
        camera.rotation.z = view.roll;
        camera.left = -halfWidth;
        camera.right = halfWidth;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.updateProjectionMatrix();
      }
      turn = turnOf(a, view?.roll ?? 0);
      material.uniforms.cursor.value = cursor;
      material.uniforms.rate.value = commitsPerSecond(eras, cursor);
      material.uniforms.still.value = frame.still;
      material.uniforms.beatWeight.value = frame.beatWeight;
      labelIn -= elapsed;
      if (labelIn <= 0 || jumped) {
        placeLabels(turn);
        labelIn = LABEL_SECONDS;
      }
      placeMarker(turn);
      placeBeat(turn, frame.beatWeight);
      renderer.render(scene, camera);
      return easing;
    },
    setPalette(next) {
      material.uniforms.bg.value = vector(next.bg);
      material.uniforms.ink.value = vector(next.ink);
      material.uniforms.tone.value = vector(next.value);
      renderer.setClearColor(clear(next.bg));
      onInvalidate();
    },
    setZoom,
    holdCamera() {
      const copy = (frame: View | null) => frame && { ...frame };
      const saved = { yaw, sway, cursor, reframeIn, view: copy(view), target: copy(target) };
      return () => {
        ({ yaw, sway, cursor, reframeIn } = saved);
        view = copy(saved.view);
        target = copy(saved.target);
        labelIn = 0;
        onInvalidate();
      };
    },
    mark(file) {
      marked = file;
      onInvalidate();
    },
    setTouches(next) {
      applyTouches(next);
      onInvalidate();
    },
    setBeat(beat) {
      for (const file of beatMarks) beatMark[file] = 0;
      beatFiles = beat?.files ?? null;
      beatMarks = beat?.files ? Array.from(beat.files) : [];
      for (const file of beatMarks) beatMark[file] = 1;
      geometry.getAttribute('beatMark').needsUpdate = true;
      if (!beat) {
        beatLabel.hidden = true;
        ring.hidden = true;
      } else {
        beatSha.textContent = beat.sha;
        beatSubject.textContent = beat.subject;
        beatLabel.hidden = false;
        beatLabel.style.opacity = '0';
      }
      onInvalidate();
    },
    reframeNow() {
      reframe();
      onInvalidate();
    },
    beatFiles: () => beatMarks,
    labels: () => placed,
    camera: () =>
      view ? { cx: view.cx, cy: view.cy, scale: view.scale, roll: view.roll, zoom } : null,
    point(file) {
      if (!view || file < 0 || file >= count || !alive(file)) return null;
      const { x, y } = project(file, turnOf(angle(), view.roll), { x: 0, y: 0 });
      return { x, y };
    },
    alivePoints() {
      if (!view) return [];
      const turn = turnOf(angle(), view.roll);
      const out: { x: number; y: number }[] = [];
      const into = { x: 0, y: 0 };
      for (let file = 0; file < count; file++) {
        if (!alive(file)) continue;
        project(file, turn, into);
        out.push({ x: into.x, y: into.y });
      }
      return out;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      touchTexture?.dispose();
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerUp);
      canvas.removeEventListener('pointerleave', pointerLeave);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      fade.remove();
      ringLayer.remove();
      overlay.remove();
    },
  };
}
