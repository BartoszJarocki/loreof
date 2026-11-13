import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

// The home page reads Redis, so this spec starts its own app against the local test Redis.
// It never reads the production gallery and never needs the production Blob store.
const testRedis = {
  KV_REST_API_URL: process.env.KV_REST_API_URL ?? 'http://127.0.0.1:8104',
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ?? 'lore-ci',
};

let server: ChildProcess | undefined;
let base: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not reserve a port for the app.'));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHome() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The app did not serve the home page.');
}

test.beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...testRedis,
        KV_URL: '',
        REDIS_URL: '',
        LORE_REDIS_PREFIX: process.env.LORE_REDIS_PREFIX ?? 'browser-paste',
      },
      stdio: 'ignore',
    },
  );
  await waitForHome();
});

test.afterAll(() => {
  server?.kill();
});

async function paste(page: Page, text: string) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.locator('#repository').click();
  await page.keyboard.press('ControlOrMeta+V');
}

test('pasting a GitHub URL replaces the whole input with owner/name', async ({ page }) => {
  await page.goto(base);
  const input = page.locator('#repository');
  await input.fill('stale/repository');
  await paste(page, 'https://github.com/n8n-io/n8n?tab=readme-ov-file');
  await expect(input).toHaveValue('n8n-io/n8n');
});

test('pasting text that is not a repository is left as pasted', async ({ page }) => {
  await page.goto(base);
  const input = page.locator('#repository');
  await paste(page, 'not a repo');
  await expect(input).toHaveValue('not a repo');
});
