export function createRenderLoop(draw: (elapsed: number, now: number) => boolean) {
  let frame: number | null = null;
  let previous: number | null = null;
  let enabled = true;
  let disposed = false;
  function invalidate() {
    if (disposed || !enabled || frame !== null) return;
    frame = requestAnimationFrame(tick);
  }
  function tick(now: number) {
    frame = null;
    const elapsed = previous === null ? 0 : Math.min((now - previous) / 1000, 0.15);
    previous = now;
    const continuing = draw(elapsed, now);
    if (continuing) invalidate();
    if (frame === null) previous = null;
  }
  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    previous = null;
  }
  return {
    invalidate,
    setEnabled(value: boolean) {
      enabled = value;
      if (enabled) invalidate();
      else stop();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
