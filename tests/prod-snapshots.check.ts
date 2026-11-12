import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseSnapshot } from '../src/lib/snapshot';
import { chapterView } from '../src/viewer/story';

const configured = process.env.LORE_PROD_SNAPSHOTS?.trim();
const directory = configured ? resolve(configured) : undefined;
const files =
  directory && existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith('.json'))
        .sort()
    : [];
const skip = !directory
  ? 'set LORE_PROD_SNAPSHOTS to a directory of production snapshot copies'
  : !files.length && `no production snapshots in ${directory}`;

test('every production gallery snapshot parses and renders chapters', { skip }, async () => {
  assert.ok(directory);
  assert.equal(files.length, 24, `expected 24 production snapshots in ${directory}`);
  for (const file of files) {
    const snapshot = parseSnapshot(JSON.parse(await readFile(join(directory, file), 'utf8')));
    assert.ok(snapshot.eras.length > 0, `${file} has no chapters`);
    for (const era of snapshot.eras) {
      const view = chapterView(era);
      assert.ok(view.title.length > 0, `${file} chapter ${era.id} has no title`);
      assert.ok(view.beats.length > 0, `${file} chapter ${era.id} has no beats`);
      assert.ok(view.dateRange.length > 0, `${file} chapter ${era.id} has no date range`);
    }
  }
});
