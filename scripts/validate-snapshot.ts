import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseSnapshot } from '../src/lib/snapshot';

const path = process.argv[2];
assert(path, 'Pass a snapshot JSON path.');
const bytes = await readFile(path);
const snapshot = parseSnapshot(JSON.parse(bytes.toString()));
process.stdout.write(
  JSON.stringify({
    repository: snapshot.repository.slug,
    snapshot: snapshot.id,
    commits: snapshot.commits.length,
    files: snapshot.files.length,
    eras: snapshot.eras.length,
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes).byteLength,
    result: 'VERIFIED',
  }) + '\n',
);
