import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Readable } from 'node:stream';
import { get } from '@vercel/blob';
import { admit } from '../src/server/admission';
import { PublicError } from '../src/server/config';
import { ANALYSIS_DEADLINE_MS, POLL_SECONDS } from '../src/workflows/analysis-protocol';
import { blobProxy } from './helpers/blob-proxy';
import { key, redis } from '../src/server/config';
import { jobSchema } from '../src/lib/schema';
import { activeAttempt, fixture, hasStorage, isolatedStorage } from './helpers/storage';

const sandboxes = new Map<string, ReturnType<typeof sandbox>>();
const creations: { name?: string; networkPolicy?: unknown }[] = [];
function sandbox() {
  const files = new Map<string, Buffer>();
  const reads: string[] = [];
  let launches = 0;
  let deletionFailure = false;
  let writeFailure = false;
  let outputSize: number | undefined;
  let outputRegular = true;
  let outputChunks: Buffer[] | undefined;
  let outputPulled = 0;
  return {
    files,
    get launches() {
      return launches;
    },
    get reads() {
      return reads;
    },
    get outputPulled() {
      return outputPulled;
    },
    set outputSize(value: number | undefined) {
      outputSize = value;
    },
    set outputRegular(value: boolean) {
      outputRegular = value;
    },
    set outputChunks(value: Buffer[] | undefined) {
      outputChunks = value;
    },
    set deletionFailure(value: boolean) {
      deletionFailure = value;
    },
    set writeFailure(value: boolean) {
      writeFailure = value;
    },
    fs: {
      async stat(path: string) {
        if (outputSize !== undefined) return { size: outputSize, isFile: () => outputRegular };
        const file = files.get(path);
        if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        return { size: file.length, isFile: () => outputRegular };
      },
    },
    async readFile({ path }: { path: string }) {
      reads.push(path);
      if (outputChunks) {
        const chunks = outputChunks;
        return Readable.from(
          (function* () {
            for (const chunk of chunks) {
              outputPulled++;
              yield chunk;
            }
          })(),
        );
      }
      const file = files.get(path);
      return file ? Readable.from([file]) : null;
    },
    async readFileToBuffer({ path }: { path: string }) {
      reads.push(path);
      return files.get(path) ?? null;
    },
    async writeFiles(entries: { path: string; content: string | Buffer }[]) {
      for (const entry of entries) {
        files.set(entry.path, Buffer.from(entry.content));
        if (writeFailure) {
          writeFailure = false;
          throw new Error('Interrupted file upload');
        }
      }
    },
    async runCommand({ cmd, args }: { cmd: string; args: string[] }) {
      if (cmd === 'mv') {
        const staging = args[2];
        const target = args[3];
        assert.ok(staging && target);
        if (!files.has(`${target}/input.json`))
          for (const [path, content] of files)
            if (path.startsWith(`${staging}/`)) {
              files.set(target + path.slice(staging.length), content);
              files.delete(path);
            }
      } else launches++;
      return { exitCode: 0 };
    },
    async delete() {
      if (deletionFailure) throw new Error('Sandbox cleanup service unavailable');
      files.clear();
    },
  };
}

const workflow = await import('workflow');
let sleeps = 0;
let skew = 0;
let onSleep: () => void = () => {};
const epoch = Date.now();
Date.now = () => epoch + skew;
mock.module('workflow', {
  namedExports: {
    ...workflow,
    sleep: async () => {
      sleeps++;
      skew += POLL_SECONDS * 1000;
      onSleep();
    },
  },
});
mock.module('@vercel/sandbox', {
  namedExports: {
    Sandbox: {
      async get({ name }: { name: string }) {
        const found = sandboxes.get(name);
        if (!found) throw new Error('Sandbox not found');
        return found;
      },
      async create(options: { name: string }) {
        creations.push(options);
        const created = sandbox();
        sandboxes.set(options.name, created);
        return created;
      },
    },
  },
});
mock.module('../src/server/github.ts', {
  namedExports: { assertPublic: async () => {}, canonicalName: async (slug: string) => slug },
});
let narrationFailure = false;
let narrations = 0;
mock.module('../src/server/narration.ts', {
  namedExports: {
    narrateEra: async (era: unknown) => {
      narrations++;
      if (narrationFailure) throw new Error('Narration service unavailable');
      return era;
    },
  },
});
const { loadCheckpoint, saveCheckpoint, deleteCheckpoint } = await import('../src/server/storage');
const { prepare, poll, publish, fail, repositoryWorkflow } =
  await import('../src/workflows/repository');

async function prepared(attempt: Parameters<typeof prepare>[0]) {
  const { startedAt, ...rest } = await prepare(attempt);
  assert.ok(startedAt > 0);
  return rest;
}

function runningSandbox(name: string) {
  const instance = sandbox();
  instance.files.set(
    '/vercel/sandbox/run/status.json',
    Buffer.from(JSON.stringify({ state: 'running', stage: 'history', detail: 'Still reading' })),
  );
  sandboxes.set(name, instance);
  return instance;
}

async function job(id: string) {
  return jobSchema.parse(await redis().get(key(`job:${id}`)));
}

function completedSandbox(name: string, snapshot: ReturnType<typeof fixture>) {
  const instance = sandbox();
  instance.files.set(
    '/vercel/sandbox/run/status.json',
    Buffer.from(JSON.stringify({ state: 'done' })),
  );
  instance.files.set('/vercel/sandbox/run/snapshot.json', Buffer.from(JSON.stringify(snapshot)));
  sandboxes.set(name, instance);
  return instance;
}

test(
  'prepare resumes an interrupted upload and replays without replacing runner state',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = sandbox();
      instance.writeFailure = true;
      instance.deletionFailure = true;
      sandboxes.set(name, instance);
      await assert.rejects(prepare(attempt), /Interrupted file upload/);
      assert.equal(instance.files.has('/vercel/sandbox/run/status.json'), false);
      const expected = { cached: false, name };
      assert.deepEqual(await prepared(attempt), expected);
      instance.files.set(
        '/vercel/sandbox/run/status.json',
        Buffer.from(
          JSON.stringify({ state: 'running', stage: 'layout', detail: 'Existing progress' }),
        ),
      );
      assert.deepEqual(await prepared(attempt), expected);
      assert.deepEqual(
        JSON.parse(instance.files.get('/vercel/sandbox/run/status.json')!.toString()),
        {
          state: 'running',
          stage: 'layout',
          detail: 'Existing progress',
        },
      );
      assert.equal(instance.launches, 2);
    });
  },
);

test(
  'concurrent prepare installs complete inputs once and never overwrites runner status',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const instance = sandbox();
      sandboxes.set(`lore-${attempt.attemptId}`, instance);
      let writes = 0;
      let release = () => {};
      const bothWritten = new Promise<void>((resolve) => {
        release = resolve;
      });
      const write = instance.writeFiles.bind(instance);
      instance.writeFiles = async (entries) => {
        await write(entries);
        if (++writes === 2) release();
        await bothWritten;
      };
      const run = instance.runCommand.bind(instance);
      instance.runCommand = async (command) => {
        const firstLaunch = command.cmd === 'node' && instance.launches === 0;
        const result = await run(command);
        if (firstLaunch)
          instance.files.set(
            '/vercel/sandbox/run/status.json',
            Buffer.from(JSON.stringify({ state: 'done' })),
          );
        return result;
      };
      await Promise.all([prepare(attempt), prepare(attempt)]);
      const status = instance.files.get('/vercel/sandbox/run/status.json');
      assert.ok(status);
      assert.deepEqual(JSON.parse(status.toString()), { state: 'done' });
      const input = instance.files.get('/vercel/sandbox/run/input.json');
      assert.ok(input);
      assert.deepEqual(JSON.parse(input.toString()), {
        repository: snapshot.repository,
        snapshotId: snapshot.id,
      });
      assert.equal(instance.launches, 2);
    });
  },
);

test(
  'poll replay uses its persisted checkpoint after the sandbox disappears',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      completedSandbox(name, snapshot);
      assert.deepEqual(await poll(attempt, name, Date.now()), { state: 'done' });
      sandboxes.delete(name);
      assert.deepEqual(await poll(attempt, name, Date.now()), { state: 'done' });
      assert.equal((await loadCheckpoint(attempt))?.files[0]?.path, 'readme.md');
      assert.deepEqual(await prepared(attempt), { cached: true, name });
    });
  },
);

test(
  'prepare creates the sandbox with a github-only network policy',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      assert.deepEqual(await prepared(attempt), { cached: false, name });
      const created = creations.find((options) => options.name === name);
      assert.ok(created);
      assert.deepEqual(created.networkPolicy, { allow: ['github.com'] });
    });
  },
);

test(
  'poll refuses a sandbox snapshot that names another repository and saves no checkpoint',
  { skip: !hasStorage },
  async () => {
    for (const forged of [
      { slug: 'attacker/other' },
      { head: 'b'.repeat(40) },
      { owner: 'attacker' },
      { name: 'other' },
      { description: 'Forged description' },
      { stars: 999_999 },
    ]) {
      await isolatedStorage(async () => {
        const snapshot = fixture();
        const attempt = await activeAttempt(snapshot);
        const name = `lore-${attempt.attemptId}`;
        completedSandbox(name, {
          ...snapshot,
          repository: { ...snapshot.repository, ...forged },
        });
        const errors = mock.method(console, 'error', () => {});
        try {
          await assert.rejects(repositoryWorkflow(attempt), /does not match/);
        } finally {
          errors.mock.restore();
        }
        assert.equal(await loadCheckpoint(attempt), null);
        const failed = await job(snapshot.id);
        assert.equal(failed.state, 'failed');
        if (failed.state !== 'failed') throw new Error('Expected failed job');
        assert.equal(failed.retryable, false);
      });
    }
  },
);

test(
  'a sandbox output above the size limit is refused before it is read',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = completedSandbox(name, snapshot);
      instance.outputSize = 64 * 1024 * 1024 + 1;
      const errors = mock.method(console, 'error', () => {});
      try {
        await assert.rejects(repositoryWorkflow(attempt), /supported limit/);
      } finally {
        errors.mock.restore();
      }
      assert.equal(instance.reads.includes('/vercel/sandbox/run/snapshot.json'), false);
      assert.equal(await loadCheckpoint(attempt), null);
      const failed = await job(snapshot.id);
      assert.equal(failed.state, 'failed');
      if (failed.state !== 'failed') throw new Error('Expected failed job');
      assert.equal(failed.retryable, false);
    });
  },
);

test(
  'a sandbox output that is not a regular file is refused before it is opened',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = completedSandbox(name, snapshot);
      instance.outputSize = 0;
      instance.outputRegular = false;
      const errors = mock.method(console, 'error', () => {});
      try {
        await assert.rejects(repositoryWorkflow(attempt), /regular file/);
      } finally {
        errors.mock.restore();
      }
      assert.equal(instance.reads.includes('/vercel/sandbox/run/snapshot.json'), false);
      assert.equal(await loadCheckpoint(attempt), null);
      const failed = await job(snapshot.id);
      assert.equal(failed.state, 'failed');
      if (failed.state !== 'failed') throw new Error('Expected failed job');
      assert.equal(failed.retryable, false);
    });
  },
);

test(
  'a sandbox output that grows past the limit while it streams is refused',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = completedSandbox(name, snapshot);
      instance.outputSize = 1024;
      instance.outputChunks = Array.from({ length: 80 }, () => Buffer.alloc(1024 * 1024, 0x20));
      const errors = mock.method(console, 'error', () => {});
      try {
        await assert.rejects(repositoryWorkflow(attempt), /supported limit/);
      } finally {
        errors.mock.restore();
      }
      assert.ok(instance.outputPulled <= 65, `pulled ${instance.outputPulled} chunks`);
      assert.equal(await loadCheckpoint(attempt), null);
      const failed = await job(snapshot.id);
      assert.equal(failed.state, 'failed');
      if (failed.state !== 'failed') throw new Error('Expected failed job');
      assert.equal(failed.retryable, false);
    });
  },
);

test(
  'a sandbox status that streams past its limit is refused without buffering',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = runningSandbox(name);
      instance.outputSize = 1024;
      instance.outputChunks = Array.from({ length: 80 }, () => Buffer.alloc(1024, 0x20));
      const errors = mock.method(console, 'error', () => {});
      try {
        await assert.rejects(repositoryWorkflow(attempt), /status exceeds the supported limit/);
      } finally {
        errors.mock.restore();
      }
      assert.ok(instance.outputPulled <= 65, `pulled ${instance.outputPulled} chunks`);
      assert.equal(await loadCheckpoint(attempt), null);
      const failed = await job(snapshot.id);
      assert.equal(failed.state, 'failed');
      if (failed.state !== 'failed') throw new Error('Expected failed job');
      assert.equal(failed.retryable, false);
    });
  },
);

test(
  'a sandbox status that is not a regular file is refused before it is opened',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = runningSandbox(name);
      instance.outputSize = 0;
      instance.outputRegular = false;
      const errors = mock.method(console, 'error', () => {});
      try {
        await assert.rejects(repositoryWorkflow(attempt), /status is not a regular file/);
      } finally {
        errors.mock.restore();
      }
      assert.equal(instance.reads.includes('/vercel/sandbox/run/status.json'), false);
      assert.equal(await loadCheckpoint(attempt), null);
      const failed = await job(snapshot.id);
      assert.equal(failed.state, 'failed');
      if (failed.state !== 'failed') throw new Error('Expected failed job');
      assert.equal(failed.retryable, false);
    });
  },
);

test(
  'a sandbox snapshot that is not a valid snapshot ends unsupported with no checkpoint',
  { skip: !hasStorage },
  async () => {
    for (const output of [
      (snapshot: ReturnType<typeof fixture>) =>
        JSON.stringify({ ...snapshot, repository: { ...snapshot.repository, stars: '3' } }),
      () => '{ broken snapshot',
    ]) {
      await isolatedStorage(async () => {
        const snapshot = fixture();
        const attempt = await activeAttempt(snapshot);
        const name = `lore-${attempt.attemptId}`;
        const instance = sandbox();
        instance.files.set(
          '/vercel/sandbox/run/status.json',
          Buffer.from(JSON.stringify({ state: 'done' })),
        );
        instance.files.set('/vercel/sandbox/run/snapshot.json', Buffer.from(output(snapshot)));
        sandboxes.set(name, instance);
        const errors = mock.method(console, 'error', () => {});
        try {
          await assert.rejects(repositoryWorkflow(attempt), /not a valid snapshot/);
        } finally {
          errors.mock.restore();
        }
        assert.equal(await loadCheckpoint(attempt), null);
        const failed = await job(snapshot.id);
        assert.equal(failed.state, 'failed');
        if (failed.state !== 'failed') throw new Error('Expected failed job');
        assert.equal(failed.retryable, false);
      });
    }
  },
);

test(
  'publication replay remains ready after checkpoint retirement and a late failure',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      await saveCheckpoint(attempt, snapshot);
      await redis().set(key(`narration:${snapshot.id}:0`), snapshot.eras[0]);
      await publish(attempt);
      const before = await redis().get(key(`manifest:${snapshot.repository.slug}:${snapshot.id}`));
      await deleteCheckpoint(attempt);
      await publish(attempt);
      await fail(attempt, { kind: 'infrastructure', message: 'Late step failure' }, 'publish');
      assert.equal((await job(snapshot.id)).state, 'ready');
      assert.deepEqual(
        await redis().get(key(`manifest:${snapshot.repository.slug}:${snapshot.id}`)),
        before,
      );
    });
  },
);

test(
  'workflow preserves primary failure and classification when sandbox cleanup fails',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const instance = completedSandbox(`lore-${attempt.attemptId}`, snapshot);
      instance.files.set('/vercel/sandbox/run/status.json', Buffer.from('{ broken protocol'));
      instance.deletionFailure = true;
      const logs = mock.method(console, 'error', () => {});
      try {
        await assert.rejects(repositoryWorkflow(attempt), SyntaxError);
        const failed = await job(snapshot.id);
        assert.equal(failed.state, 'failed');
        if (failed.state !== 'failed') throw new Error('Expected failed job');
        assert.equal(failed.retryable, true);
        assert.equal(
          failed.message,
          'Repository processing is temporarily unavailable. You can retry later.',
        );
        const entry = logs.mock.calls.find(
          (call) => call.arguments[0] === 'repository_processing_failed',
        );
        assert.equal(entry?.arguments[1].snapshotId, snapshot.id);
        assert.equal(entry?.arguments[1].attemptId, attempt.attemptId);
        assert.equal(entry?.arguments[1].stage, 'analysis');
        assert.match(entry?.arguments[1].failure.message, /JSON|property name/);
      } finally {
        logs.mock.restore();
      }
    });
  },
);

test(
  'unsupported analysis is nonretryable while cleanup failure after success cannot fail a published job',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const instance = completedSandbox(`lore-${attempt.attemptId}`, snapshot);
      instance.files.set(
        '/vercel/sandbox/run/status.json',
        Buffer.from(
          JSON.stringify({
            state: 'failed',
            failure: { kind: 'unsupported', message: 'History exceeds the commit limit' },
          }),
        ),
      );
      await assert.rejects(repositoryWorkflow(attempt), /History exceeds the commit limit/);
      const failed = await job(snapshot.id);
      assert.equal(failed.state, 'failed');
      if (failed.state !== 'failed') throw new Error('Expected failed job');
      assert.equal(failed.retryable, false);
      const successor = await activeAttempt(snapshot);
      const success = completedSandbox(`lore-${successor.attemptId}`, snapshot);
      success.deletionFailure = true;
      await redis().set(key(`narration:${snapshot.id}:0`), snapshot.eras[0]);
      await repositoryWorkflow(successor);
      assert.equal((await job(snapshot.id)).state, 'ready');
      const manifest = await redis().get<{ artifact: { pathname: string } }>(
        key(`manifest:${snapshot.repository.slug}:${snapshot.id}`),
      );
      assert.ok(manifest);
      const artifact = await get(manifest.artifact.pathname, { access: 'private' });
      assert.equal(artifact?.statusCode, 200);
      await artifact?.stream.cancel();
    });
  },
);

test(
  'expired and superseded attempts cannot fail the current job',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const expired = await activeAttempt(snapshot);
      await redis().zadd(key('leases'), { member: snapshot.id, score: 0 });
      await assert.rejects(prepare(expired), /no longer active/);
      await fail(expired, { kind: 'infrastructure', message: 'Expired' }, 'prepare');
      assert.equal((await job(snapshot.id)).state, 'queued');
      const next = await activeAttempt(snapshot);
      await fail(expired, { kind: 'infrastructure', message: 'Superseded' }, 'prepare');
      assert.equal((await job(snapshot.id)).state, 'queued');
      assert.deepEqual(await prepared(next), { cached: false, name: `lore-${next.attemptId}` });
    });
  },
);

test(
  'a dead runner fails within the polling bound and admission can use a new sandbox',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      sleeps = 0;
      skew = 0;
      await assert.rejects(repositoryWorkflow(attempt), /analysis timed out/);
      assert.equal(
        skew,
        Math.ceil(ANALYSIS_DEADLINE_MS / (POLL_SECONDS * 1000)) * POLL_SECONDS * 1000,
      );
      assert.equal((await job(snapshot.id)).state, 'failed');
      const successor = await activeAttempt(snapshot);
      assert.deepEqual(await prepared(successor), {
        cached: false,
        name: `lore-${successor.attemptId}`,
      });
      assert.notEqual(successor.attemptId, attempt.attemptId);
    });
  },
);

test(
  'a run that outlives the sandbox budget ends too-large, is not retried, and refuses resubmission',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = runningSandbox(name);
      const logs = mock.method(console, 'error', () => {});
      sleeps = 0;
      skew = 0;
      try {
        await assert.rejects(repositoryWorkflow(attempt), /sandbox time limit/);
        assert.equal(logs.mock.calls[0]?.arguments[1].failure.kind, 'too-large');
      } finally {
        logs.mock.restore();
      }
      assert.equal(
        skew,
        Math.ceil(ANALYSIS_DEADLINE_MS / (POLL_SECONDS * 1000)) * POLL_SECONDS * 1000,
      );
      assert.equal(instance.launches, 1);
      assert.equal(instance.files.size, 0);
      const failed = await job(snapshot.id);
      assert.equal(failed.state, 'failed');
      if (failed.state !== 'failed') throw new Error('Expected failed job');
      assert.equal(failed.retryable, false);
      assert.equal(
        failed.message,
        'This repository is too large to analyze for now. Try again tomorrow.',
      );
      process.env.LORE_IP_SALT ??= 'workflow-recovery-test';
      const resubmit = () =>
        admit({ id: snapshot.id, repository: snapshot.repository, ip: 'test', observedAt: 1 });
      await assert.rejects(
        resubmit(),
        (error) =>
          error instanceof PublicError &&
          error.status === 422 &&
          error.message === 'This repository is too large to analyze for now. Try again tomorrow.',
      );
      const ttl = await redis().ttl(key(`job:${snapshot.id}`));
      assert.ok(ttl > 0 && ttl <= 24 * 60 * 60, `refusal lives at most a day, got ${ttl}s`);
      await redis().pexpire(key(`job:${snapshot.id}`), 20);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal((await resubmit()).kind, 'admitted');
    });
  },
);

test(
  'a slow runner that is still progressing finishes after the old 96-poll budget',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const name = `lore-${attempt.attemptId}`;
      const instance = runningSandbox(name);
      sleeps = 0;
      skew = 0;
      onSleep = () => {
        if (sleeps !== 100) return;
        instance.files.set(
          '/vercel/sandbox/run/status.json',
          Buffer.from(JSON.stringify({ state: 'done' })),
        );
        instance.files.set(
          '/vercel/sandbox/run/snapshot.json',
          Buffer.from(JSON.stringify(snapshot)),
        );
      };
      const quiet = mock.method(console, 'info', () => {});
      try {
        await repositoryWorkflow(attempt);
      } finally {
        onSleep = () => {};
        quiet.mock.restore();
      }
      assert.ok(sleeps >= 100 && skew < ANALYSIS_DEADLINE_MS);
      assert.equal((await job(snapshot.id)).state, 'ready');
    });
  },
);

test(
  'a retry after a narration failure reuses the finished analysis without a second sandbox',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const first = await activeAttempt(snapshot);
      completedSandbox(`lore-${first.attemptId}`, snapshot);
      narrationFailure = true;
      const quiet = mock.method(console, 'error', () => {});
      const info = mock.method(console, 'info', () => {});
      try {
        await assert.rejects(repositoryWorkflow(first), /Narration service unavailable/);
        assert.equal((await job(snapshot.id)).state, 'failed');
        assert.equal(await redis().exists(key(`checkpoint:${snapshot.id}`)), 1);
        narrationFailure = false;
        const created = sandboxes.size;
        const retry = await activeAttempt(snapshot);
        assert.equal(await loadCheckpoint(first), null);
        await repositoryWorkflow(retry);
        assert.equal(sandboxes.size, created);
        assert.equal(sandboxes.has(`lore-${retry.attemptId}`), false);
        assert.equal(
          info.mock.calls.filter((call) => call.arguments[0] === 'analysis: reused checkpoint')
            .length,
          1,
        );
      } finally {
        narrationFailure = false;
        quiet.mock.restore();
        info.mock.restore();
      }
      assert.equal((await job(snapshot.id)).state, 'ready');
      assert.equal(await loadCheckpoint(first), null);
    });
  },
);

test(
  'a retry after a publication failure publishes the stored analysis and narration',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const first = await activeAttempt(snapshot);
      completedSandbox(`lore-${first.attemptId}`, snapshot);
      narrations = 0;
      const quiet = mock.method(console, 'error', () => {});
      const info = mock.method(console, 'info', () => {});
      try {
        await blobProxy(
          async (method, path) =>
            method === 'PUT' && path.startsWith(`${prefix}snapshots/`) ? 403 : undefined,
          async () => {
            await assert.rejects(repositoryWorkflow(first));
          },
        );
        assert.equal((await job(snapshot.id)).state, 'failed');
        assert.equal(narrations, 1);
        const created = sandboxes.size;
        const retry = await activeAttempt(snapshot);
        await repositoryWorkflow(retry);
        assert.equal(sandboxes.size, created);
        assert.equal(narrations, 1);
        assert.equal(
          info.mock.calls.filter((call) => call.arguments[0] === 'analysis: reused checkpoint')
            .length,
          1,
        );
      } finally {
        quiet.mock.restore();
        info.mock.restore();
      }
      assert.equal((await job(snapshot.id)).state, 'ready');
    });
  },
);
