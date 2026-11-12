import { build } from 'esbuild';
import { chromium, test, expect, type Page } from '@playwright/test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packMap, packPaths, packTouches } from '../../src/lib/snapshot-pack';
import { snapshot } from './lifecycle-snapshot';

const parts = {
  map: gzipSync(packMap(snapshot)),
  touches: gzipSync(packTouches(snapshot)),
  paths: gzipSync(packPaths(snapshot)),
};

let bundle: string;
test.beforeAll(async () => {
  const built = await build({
    entryPoints: ['tests/browser/lifecycle-fixture.tsx'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    plugins: [
      {
        name: 'next-fixture',
        setup(builder) {
          builder.onResolve(
            { filter: /^next\/(link|image|navigation|font\/local)$|\.css$/ },
            ({ path }) => ({ path, namespace: 'next-fixture' }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'next-fixture' }, ({ path }) => ({
            contents: path.endsWith('.css')
              ? ''
              : path.endsWith('font/local')
                ? "export default () => ({ variable: '', className: '' });"
                : path.endsWith('navigation')
                  ? 'export const useRouter = () => ({ push() {}, refresh() {} });'
                  : `import React from 'react'; export default function({children, unoptimized, fill, ...props}) { return React.createElement('${path.endsWith('link') ? 'a' : 'img'}', props, children); }`,
            loader: 'js',
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  bundle = built.outputFiles[0].text;
});

declare global {
  interface Window {
    lifecycle: {
      draws: number;
      frames: number;
      commits: number;
      tracksStopped: number;
      recorder: MediaRecorder | null;
      unhandled: string[];
      pinWrites: number;
    };
    partStreams: Record<
      string,
      { started: boolean; aborted: boolean; canceled: boolean } | undefined
    >;
  }
}

type PartStats = {
  requests: Record<string, { count: number; bytes: number }>;
  urls?: Record<string, string[]>;
};

type PartOverrides = {
  map?: Uint8Array[];
  touches?: Uint8Array[];
  paths?: Uint8Array[];
  stats?: PartStats;
  delay?: Partial<Record<keyof typeof parts, number>>;
  fail?: Partial<Record<keyof typeof parts, number>>;
  stall?: Partial<Record<keyof typeof parts, boolean>>;
  stallOnce?: Partial<Record<keyof typeof parts, boolean>>;
};

async function open(page: Page, suffix = '', overrides: PartOverrides = {}) {
  await page.addInitScript(() => {
    window.lifecycle = {
      draws: 0,
      frames: 0,
      commits: 0,
      tracksStopped: 0,
      recorder: null,
      unhandled: [],
      pinWrites: 0,
    };
    window.addEventListener('unhandledrejection', (event) =>
      window.lifecycle.unhandled.push(String(event.reason)),
    );
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      window.lifecycle.draws++;
      return draw.apply(this, args);
    };
    const request = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) =>
      request((now) => {
        window.lifecycle.frames++;
        callback(now);
      });
    const capture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function (...args) {
      const stream = capture.apply(this, args);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          window.lifecycle.tracksStopped++;
          stop();
        };
      }
      return stream;
    };
    window.MediaRecorder = new Proxy(MediaRecorder, {
      construct(target, args: ConstructorParameters<typeof MediaRecorder>) {
        const recorder = new target(...args);
        window.lifecycle.recorder = recorder;
        return recorder;
      },
    });
  });
  await page.route('https://fixture.test/**', async (route) => {
    const url = route.request().url();
    if (!url.includes('/api/snapshots/'))
      return route.fulfill({
        contentType: 'text/html',
        body: '<style>.stage{width:800px;height:600px}button{min-height:24px}</style><button id="unmount">Unmount fixture</button><div id="root"></div>',
      });
    const part: keyof typeof parts = url.includes('/paths?')
      ? 'paths'
      : url.includes('/touches?')
        ? 'touches'
        : 'map';
    const stats = (overrides.stats ??= { requests: {} }).requests;
    const entry = (stats[part] ??= { count: 0, bytes: 0 });
    entry.count++;
    const urls = (overrides.stats.urls ??= {});
    (urls[part] ??= []).push(url);
    const delay = overrides.delay?.[part];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (overrides.stall?.[part]) return new Promise<never>(() => undefined);
    if (overrides.stallOnce?.[part]) {
      overrides.stallOnce[part] = false;
      return new Promise<never>(() => undefined);
    }
    const failures = overrides.fail?.[part] ?? 0;
    if (failures > 0) {
      overrides.fail![part] = failures - 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"unavailable"}',
      });
    }
    const queued = overrides[part];
    const wire = queued?.length ? queued.shift()! : parts[part];
    entry.bytes += wire.byteLength;
    return route.fulfill({
      contentType: 'application/gzip',
      body: Buffer.from(gunzipSync(wire)),
    });
  });
  await page.goto(`https://fixture.test/${suffix}`);
  await page.addScriptTag({ type: 'module', content: bundle });
  await page
    .locator(
      '.stage[data-state="ready"] canvas,.stage[data-state="fallback"],.stage [role="alert"]',
    )
    .first()
    .waitFor();
}

async function settled(page: Page) {
  await expect(async () => {
    const before = await page.evaluate(() => ({
      draws: window.lifecycle.draws,
      frames: window.lifecycle.frames,
      commits: window.lifecycle.commits,
    }));
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() => ({
        draws: window.lifecycle.draws,
        frames: window.lifecycle.frames,
        commits: window.lifecycle.commits,
      })),
    ).toEqual(before);
  }).toPass({ timeout: 5000, intervals: [150] });
  return page.evaluate(() => ({ draws: window.lifecycle.draws, frames: window.lifecycle.frames }));
}

async function orbit(page: Page) {
  const canvas = page.locator('.stage canvas');
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('The map has no bounds.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 100, bounds.y + bounds.height / 2 + 30, {
    steps: 5,
  });
  await page.mouse.up();
}

async function withPage(
  run: (page: Page, errors: string[]) => Promise<void>,
  reducedMotion: 'reduce' | 'no-preference' = 'reduce',
) {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  try {
    const page = await browser.newPage({ reducedMotion });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await run(page, errors);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.lifecycle.unhandled)).toEqual([]);
  } finally {
    await browser.close();
  }
}

test('the manifest description stays in the lede after the snapshot loads', async () => {
  await withPage(async (page) => {
    await open(page);
    await expect(page.locator('.lede')).toContainText('The React Framework');
    await expect(page.locator('.lede')).not.toContainText('A local history');
  });
});

test('the repository description is bidi-isolated from Lore copy', async () => {
  await withPage(async (page) => {
    await open(page);
    const description = page.locator('.lede bdi');
    await expect(description).toHaveCount(1);
    expect(await description.textContent()).toBe('The React Framework \u202e123.');
  });
});

async function expectTouchesRetry(bad: Uint8Array) {
  await withPage(async (page) => {
    const stats: PartStats = { requests: {} };
    await open(page, '', {
      touches: [bad, new Uint8Array(parts.touches)],
      stats,
    });
    const caption = page.locator('.map-caption');
    await expect(caption.getByRole('button', { name: 'try again' })).toBeVisible({
      timeout: 15_000,
    });
    expect(await page.locator('.stage[data-state="ready"] canvas').count()).toBe(1);
    await caption.getByRole('button', { name: 'try again' }).click();
    await expect(caption.getByText(/files$/).last()).toBeVisible({ timeout: 15_000 });
    expect(stats.requests.map).toEqual({ count: 1, bytes: parts.map.byteLength });
    expect(stats.requests.touches).toEqual({
      count: 2,
      bytes: bad.byteLength + parts.touches.byteLength,
    });
  });
}

async function expectOrderedTouchesRetry(overrides: PartOverrides) {
  await withPage(async (page) => {
    const stats: PartStats = { requests: {} };
    await open(page, '', { ...overrides, stats });
    const caption = page.locator('.map-caption');
    await expect(caption.getByRole('button', { name: 'try again' })).toBeVisible({
      timeout: 15_000,
    });
    expect(await page.locator('.stage[data-state="ready"] canvas').count()).toBe(1);
    await caption.getByRole('button', { name: 'try again' }).click();
    await expect(caption.getByText(/files$/).last()).toBeVisible({ timeout: 15_000 });
    expect(stats.requests.map).toEqual({ count: 1, bytes: parts.map.byteLength });
    expect(stats.requests.touches).toEqual({ count: 2, bytes: parts.touches.byteLength });
  });
}

test('a touches failure before the map arrives still offers the touches retry', async () => {
  await expectOrderedTouchesRetry({ delay: { map: 600 }, fail: { touches: 1 } });
});

test('a touches failure after the map arrives still offers the touches retry', async () => {
  await expectOrderedTouchesRetry({ delay: { touches: 800 }, fail: { touches: 1 } });
});

test('a touches-only failure names the flashes rather than the map', async () => {
  await withPage(async (page) => {
    await open(page, '', { fail: { touches: 1 } });
    const caption = page.locator('.map-caption');
    await expect(caption.getByRole('button', { name: 'try again' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(caption).toContainText('flashes failed');
    await expect(caption).not.toContainText('map failed');
  });
});

test('a touches download reports the flashes after the map is ready', async () => {
  await withPage(async (page) => {
    await open(page, '', { stall: { touches: true } });
    const caption = page.locator('.map-caption');
    await expect(caption).toContainText(/flashes/);
    await expect(caption).not.toContainText(/map \d/);
  });
});

test('a stalled touches part fails after 20 s and offers the touches retry', async () => {
  test.setTimeout(60_000);
  await withPage(async (page) => {
    await open(page, '', { stall: { touches: true } });
    const caption = page.locator('.map-caption');
    await expect(caption.getByRole('button', { name: 'try again' })).toBeVisible({
      timeout: 30_000,
    });
    expect(await page.locator('.stage[data-state="ready"] canvas').count()).toBe(1);
  });
});

test('a map stalled before headers recovers when the retry bypasses the preload', async () => {
  test.setTimeout(90_000);
  await withPage(async (page) => {
    const stats: PartStats = { requests: {} };
    await open(page, '', { stallOnce: { map: true }, stats });
    const caption = page.locator('.map-caption');
    const retry = page.getByRole('button', { name: 'try again' }).first();
    await expect(retry).toBeVisible({ timeout: 5_000 });
    await retry.click();
    await expect(caption.getByText(/files$/).last()).toBeVisible({ timeout: 25_000 });
    expect(stats.requests.map).toEqual({ count: 2, bytes: parts.map.byteLength });
    expect(stats.urls?.map).toHaveLength(2);
    expect(stats.urls?.map[1]).toContain('retry=m1');
  });
});

test('leaving the page aborts part bodies that already have headers', async () => {
  test.setTimeout(30_000);
  await withPage(async (page) => {
    await page.addInitScript(() => {
      const streams: Window['partStreams'] = {};
      window.partStreams = streams;
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const part = /\/api\/snapshots\/[^/]+\/(touches|paths)\?/.exec(url)?.[1];
        if (!part) return real(input, init);
        const state = { started: false, aborted: false, canceled: false };
        streams[part] = state;
        const response = await real(input, init);
        if (!response.body) return response;
        const reader = response.body.getReader();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const abort = () => {
                state.aborted = true;
                controller.error(new DOMException('Aborted', 'AbortError'));
                void reader.cancel();
              };
              const signal = init?.signal;
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
              void reader.read().then((first) => {
                if (first.done) return controller.close();
                controller.enqueue(first.value.subarray(0, 64));
                state.started = true;
              });
            },
            cancel(reason) {
              state.canceled = true;
              return reader.cancel(reason);
            },
          }),
          { headers: response.headers, status: response.status },
        );
      };
    });
    await open(page);
    await page.waitForFunction(
      () => window.partStreams.touches?.started && window.partStreams.paths?.started,
      null,
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Unmount fixture' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const streams = window.partStreams;
          return {
            touches: { started: streams.touches?.started, aborted: streams.touches?.aborted },
            paths: { started: streams.paths?.started, aborted: streams.paths?.aborted },
          };
        }),
      )
      .toEqual({
        touches: { started: true, aborted: true },
        paths: { started: true, aborted: true },
      });
  });
});

test('a truncated raw touch part retries only the touch part', async () => {
  const raw = new Uint8Array(gunzipSync(parts.touches));
  await expectTouchesRetry(new Uint8Array(gzipSync(raw.subarray(0, raw.length - 4))));
});

test('a touch header that overstates its count retries only the touch part', async () => {
  const raw = new Uint8Array(gunzipSync(parts.touches));
  const view = new DataView(raw.buffer);
  view.setUint32(12, view.getUint32(12, true) + 1, true);
  await expectTouchesRetry(new Uint8Array(gzipSync(raw)));
});

test('paused viewer sleeps and redraws on scrub, find, resize, and drag', async () => {
  await withPage(async (page) => {
    await open(page);
    await expect(page.getByRole('button', { name: 'play', exact: true })).toBeVisible();
    let idle = await settled(page);
    expect(idle.draws).toBeGreaterThan(0);
    await page.getByRole('slider', { name: 'position in history' }).fill('0');
    await expect
      .poll(() => page.evaluate(() => window.lifecycle.draws))
      .toBeGreaterThan(idle.draws);
    idle = await settled(page);
    await page.getByRole('button', { name: 'find a file' }).click();
    await page.getByRole('searchbox').fill('file-1');
    await page.locator('.find-results button').first().click();
    await expect
      .poll(() => page.evaluate(() => window.lifecycle.draws))
      .toBeGreaterThan(idle.draws);
    idle = await settled(page);
    await page.locator('.stage').evaluate((element) => {
      if (element instanceof HTMLElement) element.style.width = '650px';
    });
    await expect
      .poll(() => page.evaluate(() => window.lifecycle.draws))
      .toBeGreaterThan(idle.draws);
    await settled(page);
    const beforeDrag = await page.evaluate(() => window.lifecycle.draws);
    await orbit(page);
    await expect
      .poll(() => page.evaluate(() => window.lifecycle.draws))
      .toBeGreaterThan(beforeDrag);
    await settled(page);
    await page.getByRole('button', { name: 'Unmount fixture' }).click();
    await expect(page.locator('canvas')).toHaveCount(0);
    await settled(page);
  });
});

for (const failure of ['initialization', 'context loss']) {
  test(`fallback playback advances after WebGL ${failure}`, async () => {
    await withPage(async (page) => {
      await page.clock.install();
      if (failure === 'initialization') {
        await page.addInitScript(() => {
          HTMLCanvasElement.prototype.getContext = new Proxy(
            HTMLCanvasElement.prototype.getContext,
            {
              apply(target, canvas, args) {
                if (args[0] === 'webgl' || args[0] === 'webgl2') return null;
                return Reflect.apply(target, canvas, args);
              },
            },
          );
        });
      }
      await open(page);
      if (failure === 'context loss') {
        await page.locator('.stage canvas').evaluate((canvas) => {
          if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing map canvas.');
          const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
          if (!extension) throw new Error('Context-loss testing unavailable.');
          extension.loseContext();
        });
      }
      await expect(page.locator('.stage[data-state="fallback"]')).toBeVisible();
      const timeline = page.getByRole('slider', { name: 'position in history' });
      await timeline.fill('0');
      await page.getByRole('button', { name: 'play', exact: true }).click();
      await page.clock.runFor(31_000);
      await expect(timeline).toHaveAttribute('aria-valuetext', /commit 2 of 4/);
      await page.getByRole('button', { name: 'pause', exact: true }).click();
      await page.clock.runFor(31_000);
      await expect(timeline).toHaveAttribute('aria-valuetext', /commit 2 of 4/);
    });
  });
}

test('retrying the scene replaces its layers and resets zoom', async () => {
  await withPage(async (page) => {
    await open(page);
    const zoom = page.getByRole('button', { name: 'zoom' });
    await zoom.click();
    await expect(zoom).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.stage canvas').evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing map canvas.');
      const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context-loss testing unavailable.');
      extension.loseContext();
    });
    await expect(page.locator('.stage[data-state="fallback"]')).toBeVisible();
    await page.getByRole('button', { name: 'try again' }).click();
    await expect(page.locator('.stage[data-state="ready"] canvas')).toHaveCount(1);
    expect(await page.locator('.stage .map-fade').count()).toBe(1);
    expect(await page.locator('.stage .map-ring-layer').count()).toBe(1);
    await expect(zoom).toHaveAttribute('aria-pressed', 'false');
  });
});

test('recorder errors settle promptly without unhandled rejection or leaked tracks', async () => {
  await withPage(async (page) => {
    await open(page);
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).waitFor();
    await page.evaluate(() => window.lifecycle.recorder?.dispatchEvent(new Event('error')));
    await expect(page.locator('.map-notice')).toContainText(
      'The browser interrupted the recording.',
      { timeout: 1500 },
    );
    await expect(page.getByRole('button', { name: 'cancel' })).toHaveCount(0);
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(1);
    expect(await page.evaluate(() => window.lifecycle.recorder?.state)).toBe('inactive');
    await settled(page);
  });
});

test('recording blocks clock and seek commands, then cancellation restores the view', async () => {
  await withPage(async (page) => {
    await open(page);
    const timeline = page.getByRole('slider', { name: 'position in history' });
    await timeline.fill('2500');
    const cursor = await timeline.getAttribute('aria-valuetext');
    await page.getByRole('button', { name: 'find a file' }).click();
    await page.getByRole('searchbox').fill('file-1');
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).waitFor();
    await expect(timeline).toBeDisabled();
    await expect(page.getByRole('button', { name: 'play', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'zoom' })).toBeDisabled();
    await page.locator('.find-results button').first().click();
    await page.locator('.chapter-row').first().click();
    await page.getByRole('button', { name: 'cancel' }).click();
    await expect(page.getByRole('button', { name: 'export a clip' })).toBeEnabled();
    expect(await timeline.getAttribute('aria-valuetext')).toBe(cursor);
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(1);
    await settled(page);
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).waitFor();
    await page.getByRole('button', { name: 'Unmount fixture' }).click();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.lifecycle.tracksStopped)).toBe(2);
    await settled(page);
  });
});

test('closing find a file returns focus to its button', async () => {
  await withPage(async (page) => {
    await open(page);
    const find = page.getByRole('button', { name: 'find a file' });
    await find.click();
    await page.getByRole('searchbox').press('Escape');
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(find).toBeFocused();
    await find.click();
    await page.getByRole('button', { name: 'close' }).click();
    await expect(find).toBeFocused();
  });
});

test('a chapter change has one short live announcement', async () => {
  await withPage(async (page) => {
    await open(page);
    await expect(page.locator('.chapter[aria-live]')).toHaveCount(0);
    const live = page.locator('p.sr-only[aria-live="polite"]');
    await expect(live).toHaveCount(1);
    await expect(live).toContainText('chapter 1 of 1');
  });
});

test('space on a focused chapter summary leaves playback alone', async () => {
  await withPage(async (page) => {
    await open(page);
    const summary = page.locator('.card-more summary');
    await summary.focus();
    await summary.press(' ');
    await expect(page.locator('.card-more')).toHaveAttribute('open', '');
    await expect(page.getByRole('button', { name: 'play', exact: true })).toBeVisible();
  });
});

test('scrubbing the timeline writes one pin when the scrub ends', async () => {
  await withPage(async (page) => {
    await open(page);
    const slider = page.getByRole('slider', { name: 'position in history' });
    await page.evaluate(() => {
      const original = history.replaceState;
      history.replaceState = function (data, unused, url) {
        window.lifecycle.pinWrites++;
        return original.call(history, data, unused, url);
      };
    });
    await slider.evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Missing the range value setter.');
      for (let index = 0; index < 100; index++) {
        setter.call(input, String(index * 100));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(await page.evaluate(() => window.lifecycle.pinWrites)).toBe(0);
    await slider.evaluate((element) =>
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })),
    );
    await expect.poll(() => page.evaluate(() => window.lifecycle.pinWrites)).toBe(1);
    expect(new URL(page.url()).searchParams.get('t')).toBe('3');
  });
});

test('hiding the tab stops a recording with a notice', async () => {
  await withPage(async (page) => {
    await open(page);
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('.map-notice')).toContainText(
      'Recording stopped when the tab was hidden.',
      { timeout: 1500 },
    );
    await expect(page.getByRole('button', { name: 'cancel' })).toHaveCount(0);
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(1);
    expect(await page.evaluate(() => window.lifecycle.recorder?.state)).toBe('inactive');
    await settled(page);
  });
});

test('playback pauses without idle draws and reduced motion changes survive recording cancellation', async () => {
  await withPage(async (page) => {
    await open(page);
    const initial = await page.evaluate(() => window.lifecycle.draws);
    await expect.poll(() => page.evaluate(() => window.lifecycle.draws)).toBeGreaterThan(initial);
    await page.getByRole('button', { name: 'pause', exact: true }).click();
    await settled(page);
    await page.getByRole('button', { name: 'play', exact: true }).click();
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.map-controls button').first()).toBeDisabled();
    await page.getByRole('button', { name: 'cancel' }).click();
    await expect(page.getByRole('button', { name: 'play', exact: true })).toBeEnabled();
    await expect(page.getByRole('slider', { name: 'position in history' })).toHaveAttribute(
      'aria-valuetext',
      /commit 4 of 4/,
    );
    await settled(page);
  }, 'no-preference');
});

test('recording draw failures release the recorder and stream', async () => {
  await withPage(async (page) => {
    await open(page);
    await page.evaluate(() => {
      CanvasRenderingContext2D.prototype.drawImage = () => {
        throw new Error('Fixture draw failed.');
      };
    });
    await page.getByRole('button', { name: 'export a clip' }).click();
    await expect(page.locator('.map-notice')).toContainText('Fixture draw failed.', {
      timeout: 1500,
    });
    await expect(page.getByRole('button', { name: 'export a clip' })).toBeEnabled();
    expect(await page.evaluate(() => window.lifecycle.recorder?.state)).toBe('inactive');
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(1);
    await settled(page);
  });
});

test('context recovery redraws a paused viewer and allows another recording', async () => {
  await withPage(async (page) => {
    await open(page);
    await settled(page);
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).waitFor();
    await page.locator('.stage canvas').evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing map canvas.');
      const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context-loss testing unavailable.');
      canvas.addEventListener(
        'webglcontextlost',
        () => setTimeout(() => extension.restoreContext(), 100),
        { once: true },
      );
      extension.loseContext();
    });
    await expect(page.getByRole('button', { name: 'cancel' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'export a clip' })).toBeEnabled();
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(1);
    await settled(page);
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).click();
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(2);
    await settled(page);
  });
});

test('cancellation releases a recording even when animation frames are suspended', async () => {
  await withPage(async (page) => {
    await open(page);
    await settled(page);
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 0;
    });
    await page.getByRole('button', { name: 'export a clip' }).click();
    await page.getByRole('button', { name: 'cancel' }).click();
    await expect(page.getByRole('button', { name: 'export a clip' })).toBeEnabled();
    await expect(page.locator('.map-notice')).toContainText('Recording cancelled.');
    expect(await page.evaluate(() => window.lifecycle.recorder?.state)).toBe('inactive');
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(1);
  });
});

test('a completed recording downloads a nonempty clip and releases its stream', async () => {
  test.setTimeout(45_000);
  await withPage(async (page) => {
    await open(page);
    const downloaded = page.waitForEvent('download', { timeout: 35_000 });
    await page.getByRole('button', { name: 'export a clip' }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('lore-history-3.webm');
    const stream = await download.createReadStream();
    if (!stream) throw new Error('The recording download has no bytes.');
    let bytes = 0;
    for await (const chunk of stream) bytes += chunk.length;
    expect(bytes).toBeGreaterThan(1000);
    await expect(page.locator('.map-notice')).toContainText('Your clip is ready.');
    await expect(page.locator('.map-notice')).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByRole('button', { name: 'export a clip' })).toBeEnabled();
    expect(await page.evaluate(() => window.lifecycle.recorder?.state)).toBe('inactive');
    expect(await page.evaluate(() => window.lifecycle.tracksStopped)).toBe(1);
    await settled(page);
  });
});
