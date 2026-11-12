type RecordingResult = { kind: 'recorded'; blob: Blob } | { kind: 'failed'; error: unknown };

export function recordCanvas({
  canvas,
  mimeType,
  signal,
  draw,
}: {
  canvas: HTMLCanvasElement;
  mimeType: string;
  signal: AbortSignal;
  draw: (seconds: number) => void;
}): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let frame: number | null = null;
    let settled = false;
    const chunks: Blob[] = [];
    function finish(result: RecordingResult) {
      if (settled) return;
      settled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      signal.removeEventListener('abort', abort);
      document.removeEventListener('visibilitychange', hidden);
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch (error) {
          if (result.kind === 'recorded') result = { kind: 'failed', error };
        }
      }
      stream?.getTracks().forEach((track) => track.stop());
      if (result.kind === 'recorded') resolve(result.blob);
      else reject(result.error);
    }
    function abort() {
      finish({ kind: 'failed', error: new Error('Recording cancelled.') });
    }
    function hidden() {
      if (document.visibilityState === 'hidden')
        finish({
          kind: 'failed',
          error: new Error('Recording stopped when the tab was hidden.'),
        });
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    document.addEventListener('visibilitychange', hidden);
    try {
      stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const elapsed = performance.now() - started;
        (mimeType.includes('webm') ? withDuration(blob, elapsed) : Promise.resolve(blob)).then(
          (recorded) => finish({ kind: 'recorded', blob: recorded }),
          (error: unknown) => finish({ kind: 'failed', error }),
        );
      };
      recorder.onerror = () =>
        finish({ kind: 'failed', error: new Error('The browser interrupted the recording.') });
      const started = performance.now();
      recorder.start(1000);
      if (settled) return;
      function tick(now: number) {
        frame = null;
        if (settled) return;
        try {
          const seconds = Math.min(20, Math.floor((now - started) / (1000 / 30)) / 30);
          draw(seconds);
          if (settled) return;
          if (seconds >= 20) recorder?.stop();
          else frame = requestAnimationFrame(tick);
        } catch (error) {
          finish({ kind: 'failed', error });
        }
      }
      frame = requestAnimationFrame(tick);
    } catch (error) {
      finish({ kind: 'failed', error });
    }
  });
}

const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

type Element = { id: number; start: number; dataStart: number; end: number };

function readVint(bytes: Uint8Array, at: number, keepMarker: boolean) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[at + index];
    if (bytes[at + index] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !keepMarker && unknown };
}

function readElement(bytes: Uint8Array, at: number): Element | null {
  const id = readVint(bytes, at, true);
  if (!id) return null;
  const size = readVint(bytes, at + id.length, false);
  if (!size) return null;
  const dataStart = at + id.length + size.length;
  return {
    id: id.value,
    start: at,
    dataStart,
    end: size.unknown ? Infinity : dataStart + size.value,
  };
}

function sizeVint(size: number) {
  const bytes = new Uint8Array(8);
  bytes[0] = 0x01;
  new DataView(bytes.buffer).setUint32(4, size);
  return bytes;
}

/**
 * MediaRecorder writes WebM as a live stream with no Duration in Segment Info, so players and
 * ffprobe can't show its length or seek. This writes one, given the recording's length.
 */
export async function withDuration(blob: Blob, milliseconds: number): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const header = readElement(head, 0);
  const segment = header && readElement(head, header.end);
  if (!segment || segment.id !== SEGMENT) return blob;
  let child = readElement(head, segment.dataStart);
  while (child && child.id !== INFO) {
    if (child.id === SEEK_HEAD || child.end === Infinity) return blob;
    child = readElement(head, child.end);
  }
  if (!child || child.end > head.length) return blob;
  const info = child;
  let scale = 1_000_000;
  let duration: Element | null = null;
  for (let at = info.dataStart; at < info.end;) {
    const field = readElement(head, at);
    if (!field || field.end > info.end) return blob;
    if (field.id === TIMECODE_SCALE) {
      scale = 0;
      for (let index = field.dataStart; index < field.end; index++)
        scale = scale * 256 + head[index];
    }
    if (field.id === DURATION) duration = field;
    at = field.end;
  }
  const value = (milliseconds * 1_000_000) / Math.max(1, scale);
  if (duration) {
    const patched = head.slice(0, info.end);
    const view = new DataView(patched.buffer);
    if (duration.end - duration.dataStart === 8) view.setFloat64(duration.dataStart, value);
    else if (duration.end - duration.dataStart === 4) view.setFloat32(duration.dataStart, value);
    else return blob;
    return new Blob([patched, blob.slice(info.end)], { type: blob.type });
  }
  const field = new Uint8Array(11);
  field.set([0x44, 0x89, 0x88]);
  new DataView(field.buffer).setFloat64(3, value);
  const body = head.slice(info.dataStart, info.end);
  return new Blob(
    [
      head.slice(0, info.start),
      head.slice(info.start, info.start + 4),
      sizeVint(body.length + field.length),
      body,
      field,
      blob.slice(info.end),
    ],
    { type: blob.type },
  );
}
