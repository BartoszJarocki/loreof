import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const tokens = ['bg', 'ink', 'body', 'faint', 'rule', 'wash', 'value'];
const globals = 'src/app/globals.css';
const read = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function block(css: string, opening: RegExp) {
  const match = opening.exec(css);
  assert.ok(match, `no block matches ${opening}`);
  const start = match.index + match[0].length;
  const end = css.indexOf('}', start);
  return { text: css.slice(start, end), start: match.index, end: end + 1 };
}

const light = (css: string) => block(css, /^:root\s*\{/m);
const dark = (css: string) =>
  block(css, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{/);

const declared = (text: string) =>
  Object.fromEntries(
    [...text.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );

const namedColors =
  /(?<![-\w])(white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|olive|maroon|lime|aqua|fuchsia|beige|ivory|gold|tan|khaki|crimson|coral|salmon)(?![-\w])/gi;

function literalColors(css: string) {
  return [
    ...css.matchAll(/#[0-9a-f]{3,8}\b/gi),
    ...css.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi),
    ...css.matchAll(namedColors),
  ].map((match) => match[0]);
}

test('the color detector finds each kind of literal color', () => {
  assert.deepEqual(
    literalColors(
      'a { color: #fff; background: rgb(0 0 0); border-color: oklch(50% 0 0); fill: White; }',
    ),
    ['#fff', 'rgb(', 'oklch(', 'White'],
  );
  assert.deepEqual(literalColors('a { color: var(--ink); background: transparent; }'), []);
});

test('each of the seven tokens has a light and a dark value', () => {
  const css = read(globals);
  assert.deepEqual(Object.keys(declared(light(css).text)), tokens);
  assert.deepEqual(Object.keys(declared(dark(css).text)), tokens);
  assert.equal(declared(light(css).text).bg, 'oklch(98.4% 0.0025 95)');
  assert.equal(declared(dark(css).text).bg, 'oklch(15.5% 0.004 70)');
});

test('no literal color appears outside the two token blocks', () => {
  const css = read(globals);
  const lightBlock = light(css);
  const darkBlock = dark(css);
  const rest =
    css.slice(0, lightBlock.start) +
    css.slice(lightBlock.end, darkBlock.start) +
    css.slice(darkBlock.end);
  assert.deepEqual(literalColors(rest), []);
  for (const path of cssFiles('src').filter((path) => path !== globals))
    assert.deepEqual(literalColors(read(path)), [], path);
});
