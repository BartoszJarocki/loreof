import { parseSnapshot } from '../../src/lib/snapshot';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { fileVisible, pathAt } from '../../src/viewer/playback';
import { readSnapshotJson, snapshotDirectory, snapshotSkipReason } from './snapshot-data';

const base = process.env.LORE_TEST_URL ?? 'http://localhost:3000';
test.setTimeout(180_000);
const directory = 'test-results/viewer-browser';
const webglArgs = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];

async function waitForMap(page: Page) {
  await page.waitForSelector(
    '.stage[data-state="ready"], .stage[data-state="fallback"], .stage [role="alert"]',
  );
  assert.equal(
    await page.locator('.stage[data-state="ready"] canvas').count(),
    1,
    await page.locator('.stage').innerText(),
  );
}
const commitOf = async (page: Page) =>
  Number(
    (
      await page.getByRole('slider', { name: 'position in history' }).getAttribute('aria-valuetext')
    )?.match(/commit (\d+) of/)?.[1],
  ) - 1;
async function mapPixels(page: Page) {
  await page.waitForTimeout(1500);
  return page.locator('.stage canvas').evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error('The scene is not a canvas.');
    const gl = node.getContext('webgl2');
    if (!gl) throw new Error('The scene has no WebGL2 context.');
    const pixels = new Uint8Array(node.width * node.height * 4);
    gl.readPixels(0, 0, node.width, node.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
    return hash >>> 0;
  });
}
async function screenshot(page: Page, name: string) {
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}
/** Evidence stays out of the tracked tree; test-results is ignored. */
async function scratchScreenshot(page: Page, name: string) {
  await screenshot(page, name);
}
async function documentaryUrl(page: Page) {
  await page.goto(base ?? 'http://localhost:3000');
  const href = await page.locator('#collection a.index-row').first().getAttribute('href');
  assert.ok(href, 'the real gallery contains a published documentary');
  return new URL(href, base).href;
}

test('the viewer loads the map without DecompressionStream', async () => {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ args: webglArgs });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      Object.defineProperty(window, 'DecompressionStream', {
        configurable: true,
        value: undefined,
      });
    });
    const page = await context.newPage();
    const documentary = await documentaryUrl(page);
    await page.goto(documentary);
    await waitForMap(page);
    assert.equal(await page.getByRole('button', { name: 'pause', exact: true }).count(), 1);
    await scratchScreenshot(page, 'without-decompression-stream');
  } finally {
    await browser?.close();
  }
});

test('the viewer works with real published artifacts on desktop, mobile, and fallback browsers', async () => {
  test.skip(!snapshotDirectory, snapshotSkipReason);
  await mkdir(directory, { recursive: true });
  let browser: Browser | null = null;
  let fallbackBrowser: Browser | null = null;
  try {
    browser = await chromium.launch({ args: webglArgs });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /THREE|Shader|WebGLProgram/.test(message.text()))
        errors.push(message.text());
    });
    const documentary = await documentaryUrl(page);
    await screenshot(page, 'landing-desktop');
    await page.goto(documentary);
    await waitForMap(page);
    const url = new URL(documentary);
    const slug = url.pathname.slice(1);
    const snapshot = parseSnapshot(readSnapshotJson(slug));
    const slider = page.getByRole('slider', { name: 'position in history' });
    const initialCursor = await commitOf(page);
    await expect.poll(() => commitOf(page)).toBeGreaterThan(initialCursor);
    await page.getByRole('button', { name: 'pause', exact: true }).click();
    const pausedCursor = await commitOf(page);
    await page.waitForTimeout(200);
    assert.equal(await commitOf(page), pausedCursor, 'pause stops the documentary clock');
    assert.equal(new URL(page.url()).searchParams.get('t'), String(pausedCursor), 'pause pins ?t=');
    await page.getByRole('button', { name: 'play', exact: true }).click();
    const canvas = page.locator('.stage canvas');
    await canvas.scrollIntoViewIfNeeded();
    const stageBounds = await canvas.boundingBox();
    assert.ok(stageBounds);
    await page.mouse.move(
      stageBounds.x + stageBounds.width / 2,
      stageBounds.y + stageBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      stageBounds.x + stageBounds.width / 2 + 60,
      stageBounds.y + stageBounds.height / 2 + 20,
      { steps: 5 },
    );
    await page.mouse.up();
    assert.equal(
      await page.getByRole('button', { name: 'pause', exact: true }).count(),
      1,
      'turning the map keeps the tour playing',
    );
    await page.getByRole('button', { name: 'pause', exact: true }).click();
    await slider.focus();
    await slider.press('End');
    await expect.poll(() => commitOf(page)).toBe(snapshot.commits.length - 1);
    const endingVisible = snapshot.files.filter((file) =>
      fileVisible(file, snapshot.commits.length - 1),
    );
    assert.match(
      (await page.locator('.map-caption').textContent()) ?? '',
      new RegExp(`${new Intl.NumberFormat('en').format(endingVisible.length)}\\s*files`),
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const rendered = await canvas.evaluate((node) => {
      if (!(node instanceof HTMLCanvasElement)) throw new Error('The scene is not a canvas.');
      const gl = node.getContext('webgl2');
      if (!gl) throw new Error('The scene has no WebGL2 context.');
      const pixels = new Uint8Array(node.width * node.height * 4);
      gl.readPixels(0, 0, node.width, node.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let colored = 0;
      let samples = 0;
      for (let index = 0; index < pixels.length; index += 64) {
        samples++;
        const distance =
          Math.abs(pixels[index] - pixels[0]) +
          Math.abs(pixels[index + 1] - pixels[1]) +
          Math.abs(pixels[index + 2] - pixels[2]);
        if (distance > 24) colored++;
      }
      return { colored, samples };
    });
    assert.ok(
      rendered.colored > 50,
      `the scene renders file points on the page color, observed ${rendered.colored} of ${rendered.samples}`,
    );
    assert.ok(rendered.colored < rendered.samples / 2, 'the scene is not a blank framebuffer');
    assert.deepEqual(errors, []);
    await screenshot(page, 'documentary-desktop');
    await page.getByRole('button', { name: 'restart' }).click();
    await page.getByRole('button', { name: 'pause', exact: true }).click();
    assert.ok(
      (await commitOf(page)) < snapshot.commits.length / 10,
      'restart returns to the beginning',
    );
    const late = snapshot.files.find((file) => file.born > 0);
    if (late) {
      await slider.focus();
      await slider.press('Home');
      await page.getByRole('button', { name: 'find a file' }).click();
      await page.getByRole('searchbox').fill(pathAt(late, late.born));
      await page.locator('.find-results button').first().click();
      const born = Math.min(
        ...snapshot.files
          .filter((file) =>
            file.paths.some(([, path]) =>
              path.toLowerCase().includes(pathAt(late, late.born).toLowerCase()),
            ),
          )
          .map((file) => file.born),
      );
      await expect.poll(() => commitOf(page)).toBe(born);
      assert.equal(await page.locator('.map-mark').isVisible(), true, 'the found file is marked');
    }
    await page.locator('.chapter-row').last().click();
    assert.match(
      (await page.locator('.map-caption').textContent()) ?? '',
      new RegExp(`chapter ${snapshot.eras.length} of ${snapshot.eras.length}`, 'i'),
    );
    await page.getByRole('button', { name: 'pause', exact: true }).click();
    await slider.focus();
    await slider.press('End');
    const pin = page.url();
    assert.equal(new URL(pin).searchParams.get('s'), snapshot.id);
    assert.equal(new URL(pin).searchParams.get('t'), String(snapshot.commits.length - 1));
    const pinnedPage = await context.newPage();
    await pinnedPage.goto(pin);
    await waitForMap(pinnedPage);
    assert.equal(await commitOf(pinnedPage), snapshot.commits.length - 1);
    assert.equal(await pinnedPage.getByRole('button', { name: 'play', exact: true }).count(), 1);
    const ogImage = await pinnedPage.locator('meta[property="og:image"]').getAttribute('content');
    assert.ok(ogImage);
    assert.equal(new URL(ogImage).searchParams.get('era'), String(snapshot.eras.length - 1));
    await pinnedPage.close();
    const beforeExport = await commitOf(page);
    const mapBeforeExport = await mapPixels(page);
    const downloadPromise = page.waitForEvent('download', { timeout: 50_000 });
    await page.getByRole('button', { name: 'export a clip', exact: true }).click();
    const download = await downloadPromise;
    const clip = `${directory}/${download.suggestedFilename()}`;
    await download.saveAs(clip);
    const bytes = await readFile(clip);
    assert.ok(bytes.length > 10_000, 'the browser writes a real nonempty video');
    assert.ok(
      bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ||
        bytes.subarray(4, 8).toString() === 'ftyp',
      'the download is WebM or MP4',
    );
    if (bytes[0] === 0x1a)
      assert.ok(
        bytes.subarray(0, 4096).includes(Buffer.from([0x44, 0x89, 0x88])),
        'the WebM declares its duration',
      );
    assert.equal(await commitOf(page), beforeExport, 'export restores the selected commit');
    assert.equal(await mapPixels(page), mapBeforeExport, 'export leaves the paused map unturned');
    assert.deepEqual(errors, []);
    await page.evaluate(() =>
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined }),
    );
    await page.getByRole('button', { name: 'export a clip', exact: true }).click();
    assert.match(
      (await page.locator('.map-notice').textContent()) ?? '',
      /This browser cannot record the map/,
    );
    const mobile = await browser.newContext({
      viewport: { width: 320, height: 740 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(base);
    await mobilePage.getByRole('textbox', { name: 'Public GitHub repository' }).waitFor();
    assert.equal(
      await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'landing fits 320px',
    );
    await screenshot(mobilePage, 'landing-mobile');
    await mobilePage.goto(pin);
    await waitForMap(mobilePage);
    assert.equal(
      await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'viewer fits 320px',
    );
    await screenshot(mobilePage, 'documentary-mobile');
    const reduced = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const reducedPage = await reduced.newPage();
    await reducedPage.goto(documentary);
    await waitForMap(reducedPage);
    assert.equal(await commitOf(reducedPage), snapshot.commits.length - 1);
    assert.equal(await reducedPage.getByRole('button', { name: 'play', exact: true }).count(), 1);
    await screenshot(reducedPage, 'reduced-motion');
    fallbackBrowser = await chromium.launch({ args: ['--disable-webgl'] });
    const fallback = await fallbackBrowser.newPage({ viewport: { width: 1280, height: 900 } });
    await fallback.goto(documentary);
    await fallback.locator('.stage[data-state="fallback"]').waitFor();
    assert.ok((await fallback.locator('.chapter-row').count()) > 0);
    assert.ok((await fallback.locator('.chapter-beats li').count()) > 0);
    await screenshot(fallback, 'without-webgl');
  } finally {
    await fallbackBrowser?.close();
    await browser?.close();
  }
});

test('the progress line never runs backwards', async () => {
  const browser = await chromium.launch({ args: webglArgs });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 562.5,
      downloadThroughput: 180_000,
      uploadThroughput: 84_375,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      const lines: number[][] = [];
      Object.defineProperty(window, '__progressLines', { value: lines });
      const read = () => {
        const text =
          document.querySelector('.map-caption > span:last-child')?.textContent?.trim() ?? '';
        const match = /^map ([\d.]+) of ([\d.]+) mb$/.exec(text);
        if (!match) return;
        const line = [Number(match[1]), Number(match[2])];
        const last = lines.at(-1);
        if (!last || last[0] !== line[0] || last[1] !== line[1]) lines.push(line);
      };
      new MutationObserver(read).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      document.addEventListener('DOMContentLoaded', read);
    });
    const documentary = await documentaryUrl(page);
    await page.goto(documentary);
    await page.waitForFunction(
      () =>
        / files$/.test(document.querySelector('.map-caption > span:last-child')?.textContent ?? ''),
      null,
      { timeout: 180_000, polling: 200 },
    );
    const lines = await page.evaluate(
      () => (window as unknown as { __progressLines: number[][] }).__progressLines,
    );
    assert.ok(lines.length > 1, `the load shows ${lines.length} progress lines`);
    for (let index = 1; index < lines.length; index++) {
      assert.ok(
        lines[index][0] >= lines[index - 1][0],
        `the numerator went backwards: ${JSON.stringify(lines)}`,
      );
      assert.ok(
        lines[index][1] >= lines[index - 1][1],
        `the denominator went backwards: ${JSON.stringify(lines)}`,
      );
    }
    await scratchScreenshot(page, 'progress-monotonic');
  } finally {
    await browser.close();
  }
});
