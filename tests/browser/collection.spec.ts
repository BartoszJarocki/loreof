import { expect, test, type Page } from '@playwright/test';

type CellMetrics = {
  text: string;
  height: number;
  left: number;
  right: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
};

type RowMetrics = {
  text: string;
  height: number;
  left: number;
  right: number;
  paddingLeft: number;
  paddingRight: number;
  lineHeight: number;
  lead: CellMetrics;
  main: CellMetrics & { whiteSpace: string; textOverflow: string };
  trail: (CellMetrics & { whiteSpace: string }) | null;
};

async function openCollection(page: Page, width: number, colorScheme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  await page.goto('/');
  await page.locator('#collection a.index-row').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function rows(page: Page): Promise<RowMetrics[]> {
  return page.locator('#collection a.index-row').evaluateAll((links) =>
    links.map((row) => {
      const lead = row.children[0] as HTMLElement;
      const main = row.children[1] as HTMLElement;
      const trail = row.children[2] as HTMLElement | undefined;
      const style = getComputedStyle(row);
      const lineHeight = parseFloat(style.lineHeight);
      const box = (element: Element) => element.getBoundingClientRect();
      const cell = (element: HTMLElement): CellMetrics => ({
        text: element.textContent ?? '',
        height: box(element).height,
        left: box(element).left,
        right: box(element).right,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      });
      return {
        text: row.textContent ?? '',
        height: box(row).height,
        left: box(row).left,
        right: box(row).right,
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
        lineHeight,
        lead: cell(lead),
        main: {
          ...cell(main),
          whiteSpace: getComputedStyle(main).whiteSpace,
          textOverflow: getComputedStyle(main).textOverflow,
        },
        trail: trail
          ? {
              ...cell(trail),
              whiteSpace: getComputedStyle(trail).whiteSpace,
            }
          : null,
      };
    }),
  );
}

function expectOneLine(row: RowMetrics) {
  expect(Math.abs(row.height - row.lineHeight)).toBeLessThan(0.5);
  expect(Math.abs(row.lead.height - row.lineHeight)).toBeLessThan(0.5);
  expect(row.lead.scrollHeight).toBeLessThanOrEqual(row.lead.clientHeight + 1);
  expect(Math.abs(row.main.height - row.lineHeight)).toBeLessThan(0.5);
}

test('collection rows are one line at 1440 and 1024', async ({ page }) => {
  for (const width of [1440, 1024]) {
    await openCollection(page, width, 'dark');
    const collection = await rows(page);
    expect(collection).toHaveLength(24);
    for (const row of collection) {
      expectOneLine(row);
      expect(row.trail).not.toBeNull();
      expect(row.trail!.text.trim().endsWith('…')).toBe(false);
      expect(row.trail!.whiteSpace).toBe('nowrap');
      expect(row.trail!.scrollWidth).toBeLessThanOrEqual(row.trail!.clientWidth + 1);
    }
    const jarocki = collection.find((row) => /jarocki\.me/i.test(row.text));
    expect(jarocki).toBeTruthy();
    expect(Math.abs(jarocki!.lead.height - jarocki!.lineHeight)).toBeLessThan(0.5);
    expect(jarocki!.lead.scrollHeight).toBeLessThanOrEqual(jarocki!.lead.clientHeight + 1);
  }
});

test('collection rows stack onto two aligned lines at 390', async ({ page }) => {
  await openCollection(page, 390, 'light');
  const collection = await rows(page);
  expect(collection).toHaveLength(24);
  const height = collection[0].height;
  for (const row of collection) {
    expect(Math.abs(row.height - height)).toBeLessThan(0.5);
    expect(Math.abs(row.height - row.lineHeight * 2)).toBeLessThan(0.5);
    expect(Math.abs(row.lead.height - row.lineHeight)).toBeLessThan(0.5);
    expect(row.lead.scrollHeight).toBeLessThanOrEqual(row.lead.clientHeight + 1);
    expect(Math.abs(row.main.height - row.lineHeight)).toBeLessThan(0.5);
    expect(row.main.whiteSpace).toBe('nowrap');
    expect(row.main.textOverflow).toBe('ellipsis');
    expect(row.main.left).toBeCloseTo(row.lead.left, 1);
    expect(row.main.left).toBeCloseTo(row.left + row.paddingLeft, 1);
    expect(row.trail).not.toBeNull();
    const trail = row.trail!;
    expect(trail.text.trim().endsWith('…')).toBe(false);
    expect(trail.whiteSpace).toBe('nowrap');
    expect(trail.scrollWidth).toBeLessThanOrEqual(trail.clientWidth + 1);
    expect(trail.right).toBeCloseTo(row.right - row.paddingRight, 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
