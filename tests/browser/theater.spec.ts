import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test, type Browser, type Page } from '@playwright/test';
import {
  readSnapshotJson,
  snapshotDirectory,
  snapshotSkipReason,
  touchedBy,
} from './snapshot-data';

const base = process.env.LORE_TEST_URL ?? 'http://127.0.0.1:3110';
const directory = '.cache/shots/tests';
const documentary = '/react/react';

test.setTimeout(180_000);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = 'nextjs-portal { pointer-events: none !important; }';
    document.documentElement.append(style);
  });
});

type Debug = {
  snapshot(): { id: string; slug: string };
  state(): {
    tick: number;
    chapter: number;
    chapters: number;
    playing: boolean;
    beat: string | null;
    beatWeight: number;
    files: number[];
  };
  beats(): { tick: number; sha: string; subject: string; era: number }[];
  chapters(): { start: number; title: string }[];
  touched(tick: number): number[];
  flare(): number[];
  camera(): { cx: number; cy: number; scale: number; roll: number; zoom: number } | null;
  point(file: number): { x: number; y: number } | null;
  alive(): { x: number; y: number }[];
  frameTimes(ms: number): Promise<number[]>;
};

const hook = <T>(page: Page, run: (api: Debug) => T): Promise<T> =>
  page.evaluate((source) => {
    const api = (window as unknown as { __lore?: Debug }).__lore;
    if (!api) throw new Error('The development hook is missing.');
    return new Function('hook', `return (${source})(hook)`)(api) as T;
  }, run.toString());

async function waitForMap(page: Page) {
  await page.waitForSelector(
    '.stage[data-state="ready"], .stage[data-state="fallback"], .stage [role="alert"]',
    { timeout: 120_000 },
  );
  await page.waitForFunction(() => !!(window as unknown as { __lore?: unknown }).__lore, null, {
    timeout: 60_000,
  });
}
async function open(page: Page, path = documentary) {
  await page.goto(`${base}${path}`);
  await waitForMap(page);
}
async function gotoTick(page: Page, tick: number, path = documentary) {
  await page.goto(`${base}${path}?t=${Math.max(0, tick)}`);
  await waitForMap(page);
  await page.waitForTimeout(1200);
}
async function waitForTouches(page: Page, tick: number) {
  await page.waitForFunction(
    (value) => ((window as unknown as { __lore?: Debug }).__lore?.touched(value).length ?? 0) > 0,
    tick,
    { timeout: 60_000 },
  );
}
async function settle(page: Page) {
  let previous: { cx: number; cy: number; scale: number } | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const camera = await hook(page, (api) => api.camera());
    if (
      camera &&
      previous &&
      Math.abs(camera.scale - previous.scale) < 1e-4 &&
      Math.abs(camera.cx - previous.cx) < 0.01 &&
      Math.abs(camera.cy - previous.cy) < 0.01
    )
      return;
    if (camera) previous = { cx: camera.cx, cy: camera.cy, scale: camera.scale };
    await page.waitForTimeout(150);
  }
}
async function screenshot(page: Page, name: string) {
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
}

/** Seeks the loaded page through its own history pin, so a framing run never reloads for a tick. */
async function seekTick(page: Page, tick: number) {
  await page.evaluate((next) => {
    const url = new URL(window.location.href);
    url.searchParams.set('t', String(next));
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, tick);
  await page.waitForFunction(
    (next) => (window as unknown as { __lore?: Debug }).__lore?.state().tick === next,
    tick,
    { timeout: 10_000 },
  );
  await page
    .waitForFunction(
      () => ((window as unknown as { __lore?: Debug }).__lore?.state().beatWeight ?? 0) < 0.01,
      null,
      { timeout: 5_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1200);
}

async function pause(page: Page) {
  if ((await hook(page, (api) => api.state())).playing) await page.keyboard.press('Space');
  await page.waitForFunction(
    () => (window as unknown as { __lore?: Debug }).__lore?.state().playing === false,
    null,
    { timeout: 10_000 },
  );
}

/** Drive a commit moment through the real keys: pause one tick before it, then step forward. */
async function beatMoment(page: Page, sha: string, path = documentary) {
  const beats = await hook(page, (api) => api.beats());
  const beat = beats.find((item) => item.sha.toLowerCase().startsWith(sha.toLowerCase()));
  assert.ok(beat, `beat ${sha} exists`);
  await gotoTick(page, beat.tick - 1, path);
  await waitForTouches(page, beat.tick);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    (value) => (window as unknown as { __lore?: Debug }).__lore?.state().beat === value,
    beat.sha,
    { timeout: 10_000 },
  );
  return beat;
}

test('the stage fills the viewport under the chrome', async ({ page }) => {
  const viewport = page.viewportSize();
  assert.ok(viewport);
  await open(page);
  const stage = await page.locator('.stage').boundingBox();
  assert.ok(stage);
  assert.ok(Math.abs(stage.x) < 1 && Math.abs(stage.y) < 1);
  assert.ok(Math.abs(stage.width - viewport.width) < 1);
  assert.ok(Math.abs(stage.height - viewport.height) < 1);
  const chrome = await page.locator('.theater-chrome').boundingBox();
  const bottom = await page.locator('.theater-bottom').boundingBox();
  assert.ok(chrome && bottom);
  assert.ok(chrome.y >= 0 && chrome.y + chrome.height < viewport.height);
  assert.ok(bottom.y + bottom.height <= viewport.height + 1);
});

test('a commit line appears when the playhead passes its commit', async ({ page }) => {
  await open(page);
  const first = (await hook(page, (api) => api.beats()))[0];
  assert.ok(first);
  await gotoTick(page, first.tick - 1);
  const before = await page.locator('.card-lines li').count();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    (count) => document.querySelectorAll('.card-lines li').length > count,
    before,
    { timeout: 10_000 },
  );
  const after = await page.locator('.card-lines li').count();
  assert.equal(after, before + 1, 'the line appears exactly when the playhead reaches it');
  assert.match((await page.locator('.card-lines').innerText()).toLowerCase(), /2013-06/);
  await screenshot(page, 'commit-line');
});

test('the commit moment flares exactly the files the commit touched', async ({ page }) => {
  test.skip(!snapshotDirectory, snapshotSkipReason);
  for (const [path, sha] of [
    [documentary, '88e90d560'],
    [documentary, 'cf157886e'],
    ['/torvalds/linux', '96e284499'],
    ['/torvalds/linux', '95833c83f'],
  ]) {
    const snapshot = readSnapshotJson(path.slice(1)) as {
      commits: { sha: string }[];
      files: { touches?: number[] }[];
    };
    const { commit: truth, touched } = touchedBy(snapshot, sha);
    assert.ok(truth >= 0, `${sha} is in the snapshot`);
    assert.ok(touched.length > 0, `${sha} touched files`);
    await page.goto(`${base}${path}`);
    await waitForMap(page);
    const beat = await beatMoment(page, sha, path);
    assert.equal(beat.tick, truth, `${sha} resolves to its own commit tick`);
    await page.waitForFunction(
      () => ((window as unknown as { __lore?: Debug }).__lore?.state().beatWeight ?? 0) > 0.5,
      null,
      { timeout: 10_000 },
    );
    const flare = await hook(page, (api) => api.flare());
    assert.deepEqual(
      [...flare].sort((a, b) => a - b),
      touched.sort((a, b) => a - b),
      `${sha} flares exactly the files the commit touched`,
    );
  }
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a commit moment changes neither camera scale nor camera position', async ({ page }) => {
    await gotoTick(page, 3450);
    await waitForTouches(page, 3450);
    const base = await hook(page, (api) => api.camera());
    assert.ok(base);
    await gotoTick(page, 3449);
    await waitForTouches(page, 3450);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () => (window as unknown as { __lore?: Debug }).__lore?.state().beat === 'cf157886e',
      null,
      { timeout: 10_000 },
    );
    const scales: number[] = [];
    for (let sample = 0; sample < 6; sample++) {
      const camera = await hook(page, (api) => api.camera());
      assert.ok(camera);
      scales.push(camera.scale);
      await page.waitForTimeout(160);
    }
    for (const scale of scales)
      assert.ok(
        Math.abs(scale / base.scale - 1) < 0.02,
        `scale stays at the unzoomed frame, ${base.scale} to ${scale}`,
      );
    assert.equal(
      await page.evaluate(() => !document.querySelector<HTMLElement>('.map-ring')?.hidden),
      false,
      'no ring under reduced motion',
    );
  });
});

const framingCases: {
  name: string;
  path: string;
  ticks?: number[];
  chapters?: number[];
  /** Measured on the production build, minus 0.02 for dev timing and sway. */
  floors: { tick?: number; chapter?: number; floor: number }[];
}[] = [
  {
    name: 'react',
    path: documentary,
    ticks: [0, 3450, 8000, 13725],
    floors: [{ tick: 13725, floor: 0.337 }],
  },
  { name: 'next.js', path: '/vercel/next.js', chapters: [0, 1], floors: [] },
  {
    name: 'linux',
    path: '/torvalds/linux',
    chapters: [4, 5],
    floors: [
      { chapter: 4, floor: 0.165 },
      { chapter: 9, floor: 0.218 },
    ],
  },
  {
    name: 'TypeScript',
    path: '/microsoft/TypeScript',
    chapters: [4],
    floors: [{ chapter: 4, floor: 0.3 }],
  },
];

for (const sample of framingCases) {
  test(`framing keeps the 2-98 core clear in ${sample.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, sample.path);
    await pause(page);
    const chapters = await hook(page, (api) => api.chapters());
    const ticks = sample.ticks ?? sample.chapters!.map((index) => chapters[index].start);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      for (const tick of ticks) {
        await seekTick(page, tick);
        await settle(page);
        await assertClear(page, sample.path, tick, viewport);
      }
    }
    if (sample.floors.length === 0) return;
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const entry of sample.floors) {
      const tick = entry.tick ?? chapters[entry.chapter ?? 0].start;
      await seekTick(page, tick);
      await settle(page);
      const share = await coreShare(page, 1440, 900);
      assert.ok(
        share >= entry.floor,
        `${sample.path} tick ${tick} has a 2-98 core share of ${share.toFixed(3)}, floor ${entry.floor}`,
      );
    }
  });
}

async function coreShare(page: Page, width: number, height: number) {
  const points = await hook(page, (api) => api.alive());
  if (points.length < 50) return 0;
  const xs = points.map((point) => point.x).sort((a, b) => a - b);
  const ys = points.map((point) => point.y).sort((a, b) => a - b);
  const at = (values: number[], share: number) =>
    values[Math.min(values.length - 1, Math.floor(share * values.length))];
  return ((at(xs, 0.98) - at(xs, 0.02)) * (at(ys, 0.98) - at(ys, 0.02))) / (width * height);
}

async function assertClear(
  page: Page,
  path: string,
  tick: number,
  viewport: { width: number; height: number },
  title?: string,
) {
  const rects = await page.evaluate(() =>
    ['.theater-chrome', '.chapter-card', '.theater-bottom'].map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`the overlay ${selector} is missing`);
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) throw new Error(`the overlay ${selector} has no size`);
      return { selector, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }),
  );
  const points = await hook(page, (api) => api.alive());
  const xs = points.map((point) => point.x).sort((a, b) => a - b);
  const ys = points.map((point) => point.y).sort((a, b) => a - b);
  const at = (values: number[], share: number) =>
    values[Math.min(values.length - 1, Math.floor(share * values.length))];
  const [x0, x1, y0, y1] = [at(xs, 0.02), at(xs, 0.98), at(ys, 0.02), at(ys, 0.98)];
  const core = points.filter(
    (point) => point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1,
  );
  const under = core.filter((point) =>
    rects.some(
      (box) =>
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom,
    ),
  );
  assert.deepEqual(
    under.slice(0, 8),
    [],
    `${path} tick ${tick}${title ? ` (${title})` : ''} at ${viewport.width}x${viewport.height} leaves the 2-98 core out of the chrome`,
  );
}

test('the timeline bars vary with real commit activity inside a chapter', async ({ page }) => {
  await open(page);
  await waitForTouches(page, 3450);
  const heights = await page
    .locator('.timeline-bars i')
    .evaluateAll((bars) => bars.map((bar) => Math.round(bar.getBoundingClientRect().height)));
  const perChapter = heights.length / 10;
  const varied = Array.from(
    { length: 10 },
    (_, chapter) => new Set(heights.slice(chapter * perChapter, (chapter + 1) * perChapter)).size,
  );
  assert.ok(
    varied.some((count) => count > 1),
    `bar heights vary inside a chapter: ${varied.join(',')}`,
  );
});

test('faint text on a wash plate keeps AA contrast in both schemes', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    const card = await page.evaluate(() => {
      const probe = document.createElement('canvas').getContext('2d');
      if (!probe) throw new Error('no canvas');
      const rgb = (css: string) => {
        probe.fillStyle = '#000';
        probe.fillStyle = css;
        probe.fillRect(0, 0, 1, 1);
        return Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (value: number) => {
          value /= 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: number[], b: number[]) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const range = document.querySelector('.card-range');
      const plate = document.querySelector('.chapter-card');
      if (!range || !plate) throw new Error('The card is missing.');
      return ratio(
        rgb(getComputedStyle(range).color),
        rgb(getComputedStyle(plate).backgroundColor),
      );
    });
    assert.ok(card >= 4.5, `${scheme} card text is ${card.toFixed(2)}:1`);
    await page.getByRole('button', { name: 'chapters', exact: true }).click();
    const dialog = await page.evaluate(() => {
      const probe = document.createElement('canvas').getContext('2d');
      if (!probe) throw new Error('no canvas');
      const rgb = (css: string) => {
        probe.fillStyle = '#000';
        probe.fillStyle = css;
        probe.fillRect(0, 0, 1, 1);
        return Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (value: number) => {
          value /= 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: number[], b: number[]) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const heading = document.querySelector('.chapters-head h2');
      const plate = document.querySelector('.chapters-dialog');
      if (!heading || !plate) throw new Error('The chapters dialog is missing.');
      return ratio(
        rgb(getComputedStyle(heading).color),
        rgb(getComputedStyle(plate).backgroundColor),
      );
    });
    assert.ok(dialog >= 4.5, `${scheme} dialog text is ${dialog.toFixed(2)}:1`);
  }
});

test('shortcuts do nothing behind the open chapters dialog', async ({ page }) => {
  await open(page);
  await page.locator('.map-controls .play').evaluate((button) => (button as HTMLElement).click());
  const before = await hook(page, (api) => api.state());
  await page
    .locator('.chapters-btn')
    .first()
    .evaluate((button) => (button as HTMLElement).click());
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.evaluate((element) => (element as HTMLElement).focus());
  await page.keyboard.press(']');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  assert.equal(await dialog.isVisible(), true, 'the dialog stays open');
  const after = await hook(page, (api) => api.state());
  assert.equal(after.chapter, before.chapter);
  assert.equal(after.tick, before.tick);
  assert.equal(after.playing, before.playing);
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => !!document.activeElement?.closest('dialog')),
    true,
    'tab still works inside the dialog',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await dialog.isVisible(), false);
});

test('the development hook is read-only', async ({ page }) => {
  await open(page);
  const api = await page.evaluate(() => {
    const value = (window as unknown as { __lore?: Record<string, unknown> }).__lore;
    if (!value) throw new Error('The development hook is missing.');
    return Object.fromEntries(Object.keys(value).map((name) => [name, typeof value[name]]));
  });
  for (const forbidden of ['play', 'pause', 'seekTick', 'seekChapter', 'beat'])
    assert.equal(api[forbidden], undefined, `${forbidden} is not on the hook`);
  for (const read of ['state', 'beats', 'touched', 'flare', 'camera', 'point', 'alive'])
    assert.equal(api[read], 'function', `${read} is readable`);
});

test('the ring and label stay on the files during the hold', async ({ page }) => {
  await open(page);
  const beat = await beatMoment(page, 'cf157886e');
  await page.waitForFunction(
    () => ((window as unknown as { __lore?: Debug }).__lore?.state().beatWeight ?? 0) > 0.99,
    null,
    { timeout: 10_000 },
  );
  const sample = () =>
    page.evaluate(() => {
      const api = (window as unknown as { __lore?: Debug }).__lore;
      if (!api) throw new Error('The development hook is missing.');
      const files = api.flare();
      const points = files
        .map((file) => api.point(file))
        .filter((point): point is { x: number; y: number } => point !== null);
      if (points.length === 0) throw new Error('The flare files are on screen');
      const centroid = points.reduce(
        (sum, point) => ({
          x: sum.x + point.x / points.length,
          y: sum.y + point.y / points.length,
        }),
        { x: 0, y: 0 },
      );
      const ring = document.querySelector<HTMLElement>('.map-ring');
      const ringRect = ring && !ring.hidden ? ring.getBoundingClientRect() : null;
      const label = document.querySelector<HTMLElement>('.beat-label');
      const labelRect = label && !label.hidden ? label.getBoundingClientRect() : null;
      return {
        centroid,
        weight: api.state().beatWeight,
        ring: ringRect
          ? { x: ringRect.x + ringRect.width / 2, y: ringRect.y + ringRect.height / 2 }
          : null,
        label: labelRect
          ? { x: labelRect.x + labelRect.width / 2, y: labelRect.y + labelRect.height / 2 }
          : null,
      };
    });
  await page.waitForFunction(
    () => {
      const ring = document.querySelector<HTMLElement>('.map-ring');
      return !!ring && !ring.hidden;
    },
    null,
    { timeout: 10_000 },
  );
  const early = await sample();
  await page.waitForTimeout(700);
  const late = await sample();
  assert.ok(early.ring && late.ring && late.label);
  assert.ok(late.weight > 0.99, 'both samples sit inside the hold');
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(
    distance(early.ring, early.centroid) < 8,
    `the ring sits ${distance(early.ring, early.centroid).toFixed(1)}px from the flare at the start of the hold`,
  );
  assert.ok(
    distance(late.ring, late.centroid) < 8,
    `the ring sits ${distance(late.ring, late.centroid).toFixed(1)}px from the flare`,
  );
  assert.ok(Math.abs(late.label.y - late.centroid.y) < 40, 'the label follows the flare centroid');
  assert.ok(late.ring);
  assert.equal(beat.sha, 'cf157886e');
});

test('the chapter title card fades out', async ({ page }) => {
  await open(page);
  const chapters = await hook(page, (api) => api.chapters());
  await gotoTick(page, chapters[1].start);
  const flash = page.locator('.chapter-flash');
  await flash.waitFor();
  const animation = await flash.evaluate((element) => getComputedStyle(element).animationName);
  assert.match(animation, /chapter-out/, `the title has a fade-out: ${animation}`);
  await page.waitForTimeout(1250);
  const opacity = await flash.evaluate((element) => Number(getComputedStyle(element).opacity));
  assert.ok(opacity < 0.99, `the title is fading at 1.25 s: ${opacity}`);
});

test('on a phone the controls group left and the site nav stays reachable', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'the phone project owns this check');
  const viewport = page.viewportSize();
  assert.ok(viewport);
  await open(page);
  for (const name of ['play', 'pause', 'restart', 'zoom']) {
    const button = page.getByRole('button', { name, exact: true });
    if ((await button.count()) === 0) continue;
    const box = await button.boundingBox();
    assert.ok(box);
    assert.ok(
      box.x + box.width <= viewport.width * 0.6,
      `${name} stays in the left group at ${box.x}`,
    );
  }
  await page.getByRole('button', { name: 'chapters', exact: true }).click();
  const nav = page.getByRole('dialog').getByRole('navigation', { name: 'site' });
  await nav.waitFor();
  assert.deepEqual(
    (await nav.getByRole('link').allInnerTexts()).map((text) => text.trim()),
    ['collection', 'method', 'about'],
  );
});

test('the story reads without JavaScript', async ({ page, browser }) => {
  const viewport = page.viewportSize();
  const context = await (browser as Browser).newContext({
    viewport: viewport ?? undefined,
    javaScriptEnabled: false,
    colorScheme: 'dark',
  });
  try {
    const plain = await context.newPage();
    await plain.goto(`${base}${documentary}`);
    const story = plain.locator('.repository-story');
    await story.waitFor();
    assert.equal(await story.isVisible(), true);
    const text = (await story.innerText()).toLowerCase();
    assert.match(text, /commits on/);
    assert.match(text, /chapters/);
    assert.ok((await plain.locator('.chapter-row').count()) >= 10);
    assert.ok((await plain.locator('.chapter-beats li').count()) > 0);
    assert.equal(await plain.locator('.stage').isVisible(), false);
    await screenshot(plain, 'no-javascript');
  } finally {
    await context.close();
  }
});
