import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import { put } from '@vercel/blob';
import { snapshotIdFor } from '../src/lib/identity';
import { manifestSchema, snapshotMetaSchema } from '../src/lib/schema';
import { parseSnapshot } from '../src/lib/snapshot';
import { packMap, partVersion } from '../src/lib/snapshot-pack';
import { hash, key, redis } from '../src/server/config';
import { artifactPath, readSnapshotPart } from '../src/server/storage';
import { snapshotFixture } from './fixtures/snapshot';
import { hasStorage, isolatedStorage } from './helpers/storage';

const run = promisify(execFile);
const project = resolve(import.meta.dirname, '..');

test('precompute refreshes a cached bare clone and analyzes the exact fetched default head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-precompute-'));
  try {
    const upstream = join(root, 'upstream');
    const clone = join(root, '.cache/repos/owner-repo.git');
    const destination = join(root, '.cache/gallery/owner-repo-spectral-lore-4.json');
    await mkdir(upstream);
    await mkdir(join(root, '.cache/repos'), { recursive: true });
    await mkdir(join(root, '.cache/gallery'), { recursive: true });
    await mkdir(join(root, 'bin'));
    const git = async (...args: string[]) =>
      (await run('git', args, { cwd: upstream })).stdout.trim();
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.test');
    await writeFile(join(upstream, 'readme.md'), 'first');
    await git('add', '.');
    await git('commit', '-m', 'Initial commit');
    const old = await git('rev-parse', 'HEAD');
    await git('clone', '--bare', upstream, clone);
    const snapshot = snapshotFixture();
    snapshot.repository.head = old;
    snapshot.commits[0].sha = old;
    snapshot.eras[0].facts[0].commits = [old];
    snapshot.id = snapshotIdFor(snapshot.repository);
    await writeFile(destination, JSON.stringify(snapshot));
    await symlink(join(project, 'scripts'), join(root, 'scripts'), 'dir');
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(
      join(root, 'bin/gh'),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"full_name":"owner/repo","private":false,"description":"A repository","default_branch":"main","stargazers_count":1}\'\n',
      { mode: 0o755 },
    );
    await writeFile(join(upstream, 'readme.md'), 'second');
    await git('add', '.');
    await git('commit', '-m', 'A newer remote commit');
    const head = await git('rev-parse', 'HEAD');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TSX_TSCONFIG_PATH: join(project, 'tsconfig.json'),
      PATH: join(root, 'bin') + ':' + process.env.PATH,
    };
    for (const name of [
      'KV_REST_API_URL',
      'KV_REST_API_TOKEN',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'BLOB_READ_WRITE_TOKEN',
      'VERCEL',
      'AI_GATEWAY_API_KEY',
    ])
      delete env[name];
    await run(
      process.execPath,
      ['--import', 'tsx', join(project, 'scripts/precompute.ts'), '--repo', 'owner/repo'],
      { cwd: root, env },
    );
    const actual = parseSnapshot(JSON.parse(await readFile(destination, 'utf8')));
    assert.equal(actual.repository.head, head);
    assert.equal(actual.id, snapshotIdFor({ slug: 'owner/repo', head }));
    assert.equal(actual.commits.at(-1)?.subject, 'A newer remote commit');
    assert.equal(actual.commits.length, 2);
    const record = JSON.parse(await readFile(destination + '.result.json', 'utf8'));
    assert.equal(record.reusedAnalysis, false);
    assert.equal(record.head, head);

    const { refreshDefaultBranch } = await import('../scripts/lib/precompute');
    await git('checkout', '-b', 'release/v2');
    await writeFile(join(upstream, 'readme.md'), 'third');
    await git('add', '.');
    await git('commit', '-m', 'The new default branch');
    const changedDefault = await git('rev-parse', 'HEAD');
    await assert.rejects(refreshDefaultBranch(clone, 'main'), /default branch changed/);
    await writeFile(
      join(root, 'bin/gh'),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"full_name":"owner/repo","private":false,"description":"A repository","default_branch":"release/v2","stargazers_count":1}\'\n',
      { mode: 0o755 },
    );
    await run(
      process.execPath,
      ['--import', 'tsx', join(project, 'scripts/precompute.ts'), '--repo', 'owner/repo'],
      { cwd: root, env },
    );
    const updated = parseSnapshot(JSON.parse(await readFile(destination, 'utf8')));
    assert.equal(updated.repository.head, changedDefault);
    assert.equal(updated.repository.branch, 'release/v2');
    assert.equal(updated.commits.at(-1)?.subject, 'The new default branch');

    await git('--git-dir', clone, 'remote', 'set-url', 'origin', join(root, 'missing-origin'));
    await writeFile(join(root, 'bin/gh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    await run(
      process.execPath,
      [
        '--import',
        'tsx',
        join(project, 'scripts/precompute.ts'),
        '--repo',
        'owner/repo',
        '--head',
        old,
      ],
      { cwd: root, env },
    );
    const offline = parseSnapshot(JSON.parse(await readFile(destination, 'utf8')));
    assert.equal(offline.repository.head, old);
    assert.equal(offline.commits.length, 1);
    assert.equal(offline.commits[0].subject, 'Initial commit');
    await assert.rejects(refreshDefaultBranch(clone, 'release/v2'), /fetch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'precompute convert reads storage with the lowercased repository slug',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const root = await mkdtemp(join(tmpdir(), 'lore-precompute-convert-'));
      try {
        await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
        const snapshot = snapshotFixture();
        snapshot.repository.slug = 'Owner/MixedCase';
        const slug = 'owner/mixedcase';
        const bytes = gzipSync(JSON.stringify(snapshot));
        const pathname = artifactPath(slug, snapshot.id, hash(bytes));
        await put(pathname, bytes, { access: 'private', addRandomSuffix: false });
        const manifest = manifestSchema.parse({
          ...snapshotMetaSchema.parse(snapshot),
          artifact: { pathname, sha256: hash(bytes), bytes: bytes.length },
        });
        const store = redis();
        await store.set(key(`manifest:${slug}:${snapshot.id}`), JSON.stringify(manifest));
        await store.set(key(`latest:${slug}`), snapshot.id);
        await store.sadd(key(`snapshots:${slug}`), snapshot.id);
        await store.set(key(`visible:${slug}`), '1');
        await run(
          process.execPath,
          [
            '--import',
            'tsx',
            join(project, 'scripts/precompute.ts'),
            '--convert',
            '--repo',
            'Owner/MixedCase',
          ],
          {
            cwd: root,
            env: { ...process.env, TSX_TSCONFIG_PATH: join(project, 'tsconfig.json') },
          },
        );
        const [file] = await readdir(join(root, '.cache/gallery'));
        const record = JSON.parse(await readFile(join(root, '.cache/gallery', file), 'utf8'));
        assert.deepEqual(
          record.map(
            ({ slug: recorded, id, error }: { slug: string; id?: string; error?: string }) => ({
              slug: recorded,
              id,
              error,
            }),
          ),
          [{ slug, id: snapshot.id, error: undefined }],
        );
        const part = await readSnapshotPart(slug, snapshot.id, 'map', partVersion(manifest));
        const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
        assert.ok(part);
        assert.deepEqual(gunzipSync(part), Buffer.from(packMap(parsed)));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

test('pinned offline analysis cannot publish or claim a fresh observation', async () => {
  const { precomputePolicy } = await import('../scripts/lib/precompute');
  assert.deepEqual(precomputePolicy({ head: 'a'.repeat(40), publish: false }), {
    kind: 'pinned',
    head: 'a'.repeat(40),
  });
  assert.deepEqual(precomputePolicy({ publish: true }), { kind: 'refresh' });
  assert.throws(() => precomputePolicy({ head: 'a'.repeat(40), publish: true }), /cannot publish/);
  const result = await run(process.execPath, [
    '--import',
    'tsx',
    join(project, 'scripts/precompute.ts'),
    '--repo',
    'owner/repo',
    '--head',
    'a'.repeat(40),
    '--publish',
  ]).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(result instanceof Error && 'stderr' in result);
  assert.match(String(result.stderr), /Pinned offline analysis cannot publish/);
});
