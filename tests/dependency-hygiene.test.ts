import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
};

/** Everything pnpm installed, one directory per package and version. */
const store = readdirSync(join(root, 'node_modules/.pnpm'));

/** Versions of `name` present in the store, with peer suffixes stripped. */
function installedVersions(name: string): string[] {
  const prefix = `${name.replace('/', '+')}@`;
  return store
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length).split(/[_(]/)[0])
    .filter((version) => /^\d+\.\d+\.\d+/.test(version));
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

test('no installed undici 7.x is below the release that fixes the advisories', () => {
  const versions = installedVersions('undici');
  assert.ok(
    versions.some((version) => version.startsWith('7.')),
    'expected undici 7.x in the store so the check is not vacuous',
  );
  const vulnerable = versions.filter(
    (version) => version.startsWith('7.') && compareVersions(version, '7.30.1') < 0,
  );
  assert.deepEqual(vulnerable, []);
});

test('no installed zod 4.x is below the release that fixes the memory exhaustion advisory', () => {
  const versions = installedVersions('zod');
  assert.ok(
    versions.some((version) => version.startsWith('4.')),
    'expected zod 4.x in the store so the check is not vacuous',
  );
  const vulnerable = versions.filter(
    (version) => version.startsWith('4.') && compareVersions(version, '4.6.6') < 0,
  );
  assert.deepEqual(vulnerable, []);
});

test('the store holds no sharp and no libvips binary', () => {
  assert.ok(store.length > 0, 'expected a populated node_modules/.pnpm');
  const found = store.filter(
    (entry) => entry.startsWith('sharp@') || entry.startsWith('@img+sharp-libvips-'),
  );
  assert.deepEqual(found, []);
});

test('every GitHub action in the check workflow is pinned to a commit with its tag', () => {
  const workflow = read('.github/workflows/check.yml');
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)(?:[ \t]+#[ \t]*(\S+))?/gm)];
  assert.ok(uses.length >= 4, 'expected the workflow to use actions');
  for (const [, reference, tag] of uses) {
    assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, reference);
    assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, `${reference} needs a version comment`);
  }
});

test('the repository declares one Node version for the runtime and its types', () => {
  const nvmrc = read('.nvmrc').trim();
  assert.match(nvmrc, /^\d+$/);
  assert.equal(pkg.engines?.node, `${nvmrc}.x`);
  const typesNode = pkg.devDependencies?.['@types/node'] ?? '';
  assert.match(typesNode, /^\d+\.\d+\.\d+$/);
  assert.equal(typesNode.split('.')[0], nvmrc);
});
