import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { del, get, list, put } from '@vercel/blob';
import { z } from 'zod';
import {
  manifestSchema,
  repositorySlugSchema,
  snapshotIdSchema,
  snapshotMetaSchema,
  type Manifest,
  type Snapshot,
} from '@/lib/schema';
import { parseSnapshot } from '@/lib/snapshot';
import {
  packMap,
  packPaths,
  packTouches,
  partVersion,
  PARTS,
  PARTS_FORMAT,
  type Part,
} from '@/lib/snapshot-pack';
import { GALLERY } from '@/lib/gallery';
import { hash, key, PublicError, redis } from './config';
import { assertPublic, canonicalName } from './github';
import type { JobAttempt } from './admission';

const MAX_ARTIFACT = 64 * 1024 * 1024;
const VISIBLE_TTL_SECONDS = 300;
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MISSING_TTL_SECONDS = 300;

function blobPath(pathname: string): string {
  const prefix = process.env.LORE_BLOB_PREFIX;
  if (!prefix) return pathname;
  z.string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*\/$/)
    .parse(prefix);
  return prefix + pathname;
}

const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_GRACE_MS = 5 * 60_000;
const CHECKPOINT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const RETIRED_TTL_SECONDS = 8 * 24 * 60 * 60;
const checkpointRecordSchema = z.object({
  id: snapshotIdSchema,
  slug: repositorySlugSchema,
  state: z.enum(['active', 'retired']),
  uploadUntil: z.number(),
  generation: z.number().int().nonnegative().default(0),
});
type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;
const legacyCheckpointSchema = checkpointRecordSchema.extend({ attemptId: z.string().uuid() });

function checkpointPath(record: Pick<CheckpointRecord, 'id' | 'slug' | 'generation'>): string {
  const generation = record.generation ? `.${record.generation}` : '';
  return blobPath(`checkpoints/${record.slug}/${record.id}${generation}.json.gz`);
}

async function deleteCheckpointGenerations(
  record: Pick<CheckpointRecord, 'id' | 'slug' | 'generation'>,
): Promise<void> {
  const directory = blobPath(`checkpoints/${record.slug}/`);
  const pattern = new RegExp(`^${record.id}(?:\\.(\\d+))?\\.json\\.gz$`);
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `${directory}${record.id}.`, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      const match = pattern.exec(blob.pathname.slice(directory.length));
      if (match && Number(match[1] ?? 0) <= record.generation)
        await del(blob.pathname, { abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

export const REGISTER_CHECKPOINT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'removed' end
if redis.call('GET', KEYS[7]) == ARGV[1] then return 'retired' end
local context = redis.call('GET', KEYS[2])
local job = redis.call('GET', KEYS[4])
local lease = tonumber(redis.call('ZSCORE', KEYS[3], ARGV[2]) or '0')
if not context or cjson.decode(context).attemptId ~= ARGV[1] or lease <= tonumber(ARGV[3]) or not job then return 'stale' end
local state = cjson.decode(job).state
if state ~= 'queued' and state ~= 'running' then return 'stale' end
local previous = redis.call('GET', KEYS[5])
local record = cjson.decode(ARGV[4])
local revived = false
record.generation = 0
if previous then
  local old = cjson.decode(previous)
  record.generation = old.generation or 0
  revived = old.state == 'retired'
  if revived then record.generation = record.generation + 1 end
  record.uploadUntil = math.max(record.uploadUntil, old.uploadUntil)
end
redis.call('SET', KEYS[5], cjson.encode(record))
if revived then redis.call('ZADD', KEYS[6], ARGV[5], ARGV[2]) else redis.call('ZADD', KEYS[6], 'NX', ARGV[5], ARGV[2]) end
redis.call('SADD', KEYS[8], ARGV[2])
redis.call('SADD', KEYS[9], ARGV[2])
return (revived and 'revived:' or 'registered:') .. record.generation
`;

export const CHECKPOINT_WRITABLE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'removed' end
if redis.call('GET', KEYS[5]) == ARGV[1] then return 'retired' end
local context = redis.call('GET', KEYS[2])
local job = redis.call('GET', KEYS[4])
local lease = tonumber(redis.call('ZSCORE', KEYS[3], ARGV[2]) or '0')
if not context or cjson.decode(context).attemptId ~= ARGV[1] or lease <= tonumber(ARGV[3]) or not job then return 'stale' end
local state = cjson.decode(job).state
if state ~= 'queued' and state ~= 'running' then return 'stale' end
return 'active'
`;

export const RETIRE_CHECKPOINT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if ARGV[4] == 'sweep' and raw and cjson.decode(raw).state == 'active' then
  local lease = tonumber(redis.call('ZSCORE', KEYS[5], ARGV[1]) or '0')
  local job = redis.call('GET', KEYS[6])
  if lease > tonumber(ARGV[2]) and job then
    local state = cjson.decode(job).state
    if state == 'queued' or state == 'running' then
      redis.call('ZADD', KEYS[3], lease + tonumber(ARGV[3]), ARGV[1])
      return false
    end
  end
end
local context = redis.call('GET', KEYS[4])
redis.call('SET', KEYS[2], context and cjson.decode(context).attemptId or '-', 'EX', ARGV[5])
if not raw then
  redis.call('ZREM', KEYS[3], ARGV[1])
  return false
end
local record = cjson.decode(raw)
record.state = 'retired'
redis.call('SET', KEYS[1], cjson.encode(record))
redis.call('ZADD', KEYS[3], math.max(tonumber(ARGV[2]), record.uploadUntil + tonumber(ARGV[3])), ARGV[1])
return cjson.encode(record)
`;

export const FORGET_CHECKPOINT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then
  local record = cjson.decode(raw)
  if record.state ~= 'retired' or (record.generation or 0) ~= tonumber(ARGV[2]) then return false end
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('SREM', KEYS[3], ARGV[1])
return true
`;

async function checkpointWritable(record: CheckpointRecord, attemptId: string): Promise<string> {
  return z
    .string()
    .parse(
      await redis().eval(
        CHECKPOINT_WRITABLE_SCRIPT,
        [
          key(`removed:${record.slug}`),
          key(`context:${record.id}`),
          key('leases'),
          key(`job:${record.id}`),
          key(`checkpoint-retired:${record.id}`),
        ],
        [attemptId, record.id, Date.now()],
      ),
    );
}

function rejectedCheckpoint(reason: string): Error {
  return reason === 'removed'
    ? new PublicError('This repository has been removed from Lore.', 410)
    : new Error(`Analysis checkpoint attempt is ${reason}.`);
}

async function retireCheckpoint(id: string, sweep = false): Promise<CheckpointRecord | null> {
  const raw = await redis().eval(
    RETIRE_CHECKPOINT_SCRIPT,
    [
      key(`checkpoint:${id}`),
      key(`checkpoint-retired:${id}`),
      key('checkpoints'),
      key(`context:${id}`),
      key('leases'),
      key(`job:${id}`),
    ],
    [id, Date.now(), UPLOAD_GRACE_MS, sweep ? 'sweep' : 'terminal', RETIRED_TTL_SECONDS],
  );
  return raw ? checkpointRecordSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
}

export async function deleteCheckpoint(attempt: JobAttempt): Promise<void> {
  const record = await retireCheckpoint(attempt.id);
  if (record) await deleteCheckpointGenerations(record);
}

async function sweepLegacyCheckpoint(attemptId: string, raw: unknown): Promise<boolean> {
  const store = redis();
  const record = legacyCheckpointSchema.parse(raw);
  const lease = Number(await store.zscore(key('leases'), record.id));
  if (lease > Date.now()) {
    await store.zadd(key('checkpoints'), { member: attemptId, score: lease + UPLOAD_GRACE_MS });
    return false;
  }
  if (record.uploadUntil + UPLOAD_GRACE_MS > Date.now()) return false;
  await del(blobPath(`checkpoints/${record.slug}/${record.id}/${attemptId}.json.gz`), {
    abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  await store.del(key(`checkpoint:${attemptId}`), key(`checkpoint-retired:${attemptId}`));
  await store.zrem(key('checkpoints'), attemptId);
  await store.srem(key(`checkpoints:${record.slug}`), attemptId);
  return true;
}

export async function sweepCheckpoints(): Promise<{ deleted: number; legacyDeleted: number }> {
  const store = redis();
  const due = await store.zrange<string[]>(key('checkpoints'), 0, Date.now(), {
    byScore: true,
    offset: 0,
    count: 100,
  });
  let deleted = 0;
  for (const member of due) {
    const raw = await store.get(key(`checkpoint:${member}`));
    if (!raw) {
      await store.zrem(key('checkpoints'), member);
      continue;
    }
    try {
      if (!snapshotIdSchema.safeParse(member).success) {
        if (await sweepLegacyCheckpoint(member, raw)) deleted++;
        continue;
      }
      const existing = checkpointRecordSchema.parse(raw);
      const record = await retireCheckpoint(existing.id, true);
      if (!record || record.uploadUntil + UPLOAD_GRACE_MS > Date.now()) continue;
      await deleteCheckpointGenerations(record);
      const forgotten = await store.eval(
        FORGET_CHECKPOINT_SCRIPT,
        [key(`checkpoint:${member}`), key('checkpoints'), key(`checkpoints:${record.slug}`)],
        [member, record.generation],
      );
      if (forgotten) deleted++;
    } catch (error) {
      console.error('checkpoint_cleanup_failed', { checkpoint: member, error });
    }
  }
  const cursor = await store.get<string>(key('checkpoint-legacy-cursor'));
  const page = await list({
    prefix: blobPath('checkpoints/'),
    cursor: cursor ?? undefined,
    limit: 100,
  });
  let legacyDeleted = 0;
  for (const blob of page.blobs) {
    const match = /^([a-f0-9]{24})\.json\.gz$/.exec(
      blob.pathname.slice(blobPath('checkpoints/').length),
    );
    if (
      !match ||
      Date.now() - blob.uploadedAt.getTime() < CHECKPOINT_RETENTION_MS + UPLOAD_GRACE_MS
    )
      continue;
    const id = snapshotIdSchema.parse(match[1]);
    if (Number(await store.zscore(key('leases'), id)) > Date.now()) continue;
    await del(blob.pathname);
    legacyDeleted++;
  }
  if (page.hasMore) await store.set(key('checkpoint-legacy-cursor'), page.cursor);
  else await store.del(key('checkpoint-legacy-cursor'));
  return { deleted, legacyDeleted };
}

export const REGISTER_SNAPSHOT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'removed' end
redis.call('SADD', KEYS[2], ARGV[1])
return 'registered'
`;

async function registerSnapshot(slug: string, id: string): Promise<void> {
  const result = await redis().eval(
    REGISTER_SNAPSHOT_SCRIPT,
    [key(`removed:${slug}`), key(`snapshots:${slug}`)],
    [id],
  );
  if (result === 'removed')
    throw new PublicError('This repository has been removed from Lore.', 410);
}

async function rejectRemovedWrite(slug: string, paths: string[]): Promise<void> {
  if (!(await redis().exists(key(`removed:${slug}`)))) return;
  await del(paths);
  throw new PublicError('This repository has been removed from Lore.', 410);
}

export function artifactPath(slug: string, id: string, digest: string): string {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(digest);
  return blobPath(
    `snapshots/${repositorySlugSchema.parse(slug).toLowerCase()}/${snapshotIdSchema.parse(id)}/${digest}.json.gz`,
  );
}

function partPath(slug: string, id: string, digest: string, part: Part): string {
  return artifactPath(slug, id, digest).replace(/\.json\.gz$/, `.${part}.${PARTS_FORMAT}.gz`);
}

async function putArtifact(pathname: string, bytes: Buffer, contentType: string): Promise<void> {
  try {
    await put(pathname, bytes, { access: 'private', contentType, addRandomSuffix: false });
  } catch (error) {
    const previous = await readArtifact(pathname);
    if (!previous || hash(previous) !== hash(bytes)) throw error;
  }
}

/**
 * The parts derive from the JSON artifact and the manifest's chapters. At publish both come from
 * one parse; on a later conversion the manifest is still what the page renders, so its eras win.
 */
async function writeParts(
  slug: string,
  snapshot: Snapshot,
  digest: string,
): Promise<Record<Part, Buffer>> {
  const parts = {
    map: gzipSync(packMap(snapshot), { level: 9 }),
    touches: gzipSync(packTouches(snapshot), { level: 9 }),
    paths: gzipSync(packPaths(snapshot), { level: 9 }),
  };
  for (const part of PARTS)
    await putArtifact(partPath(slug, snapshot.id, digest, part), parts[part], 'application/gzip');
  return parts;
}

function definitelyMissing(error: unknown): boolean {
  return error instanceof PublicError && [403, 404, 410].includes(error.status);
}

export async function assertVisible(slug: string, fresh = false): Promise<void> {
  const store = redis();
  if (await store.exists(key(`removed:${slug}`)))
    throw new PublicError('This repository has been removed from Lore.', 410);
  if (!fresh && (await store.exists(key(`visible:${slug}`)))) return;
  if (!fresh && (await store.exists(key(`missing:${slug}`))))
    throw new PublicError('This repository is unavailable or private.', 404);
  try {
    await assertPublic(slug);
  } catch (error) {
    if (definitelyMissing(error)) {
      await store.del(key(`visible:${slug}`), key(`seen:${slug}`));
      await store.set(key(`missing:${slug}`), '1', { ex: MISSING_TTL_SECONDS });
      throw error;
    }
    if (fresh || !(await store.exists(key(`seen:${slug}`)))) throw error;
    await store.set(key(`visible:${slug}`), '1', { ex: VISIBLE_TTL_SECONDS });
    return;
  }
  await store.set(key(`visible:${slug}`), '1', { ex: VISIBLE_TTL_SECONDS });
  await store.set(key(`seen:${slug}`), '1', { ex: SEEN_TTL_SECONDS });
}

const canonicalSchema = z.union([
  z.object({ slug: z.string() }),
  z.object({ failed: z.literal(true) }),
]);

export async function cachedCanonicalName(slug: string): Promise<string> {
  const store = redis();
  const cacheKey = key(`canonical:${slug}`);
  const stored = canonicalSchema.safeParse(await store.get(cacheKey));
  if (stored.success) {
    if ('slug' in stored.data) return stored.data.slug;
    throw new PublicError('GitHub could not be reached. Try again shortly.', 503);
  }
  try {
    const canonical = await canonicalName(slug);
    await store.set(cacheKey, { slug: canonical }, { ex: 600 });
    return canonical;
  } catch (error) {
    if (error instanceof PublicError) throw error;
    await store.set(cacheKey, { failed: true }, { ex: 60 });
    throw new PublicError('GitHub could not be reached. Try again shortly.', 503);
  }
}

export async function assertReachable(slug: string): Promise<void> {
  await assertVisible(slug);
  if (!(await readManifest(slug))) await cachedCanonicalName(slug);
}

async function readArtifact(pathname: string, cache = false): Promise<Buffer | null> {
  const blob = await get(pathname, { access: 'private', useCache: cache });
  if (!blob || blob.statusCode !== 200) return null;
  if (blob.blob.size > MAX_ARTIFACT) throw new Error('Snapshot artifact exceeds the storage limit');
  const reader = blob.stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_ARTIFACT) throw new Error('Snapshot artifact exceeds the storage limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

async function storedCheckpointMatches(pathname: string, snapshot: Snapshot): Promise<boolean> {
  const bytes = await readArtifact(pathname);
  if (!bytes) return false;
  try {
    const stored = parseSnapshot(
      JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_ARTIFACT }).toString('utf8')),
    );
    return (
      stored.id === snapshot.id &&
      stored.repository.slug.toLowerCase() === snapshot.repository.slug.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function saveCheckpoint(attempt: JobAttempt, snapshot: Snapshot): Promise<string> {
  const checked = parseSnapshot(snapshot);
  if (attempt.id !== checked.id) throw new Error('Checkpoint attempt identity mismatch');
  const slug = checked.repository.slug.toLowerCase();
  const now = Date.now();
  const fresh = checkpointRecordSchema.parse({
    id: attempt.id,
    slug,
    state: 'active',
    uploadUntil: now + UPLOAD_TIMEOUT_MS,
  });
  const registered = await redis().eval(
    REGISTER_CHECKPOINT_SCRIPT,
    [
      key(`removed:${slug}`),
      key(`context:${attempt.id}`),
      key('leases'),
      key(`job:${attempt.id}`),
      key(`checkpoint:${attempt.id}`),
      key('checkpoints'),
      key(`checkpoint-retired:${attempt.id}`),
      key(`snapshots:${slug}`),
      key(`checkpoints:${slug}`),
    ],
    [attempt.attemptId, attempt.id, now, JSON.stringify(fresh), now + CHECKPOINT_RETENTION_MS],
  );
  const [outcome, generation] = String(registered).split(':');
  if (outcome !== 'registered' && outcome !== 'revived')
    throw rejectedCheckpoint(String(registered));
  const record = { ...fresh, generation: Number(generation) };
  if (outcome === 'revived') {
    try {
      await del(checkpointPath({ ...record, generation: record.generation - 1 }), {
        abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      console.error('checkpoint_cleanup_failed', { snapshotId: attempt.id, error });
    }
  }
  const pathname = checkpointPath(record);
  const bytes = gzipSync(JSON.stringify(checked));
  if (bytes.length > MAX_ARTIFACT) throw new Error('Checkpoint artifact exceeds the storage limit');
  try {
    await put(pathname, bytes, {
      access: 'private',
      contentType: 'application/gzip',
      addRandomSuffix: false,
      abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (!(await storedCheckpointMatches(pathname, checked))) throw error;
  }
  const writable = await checkpointWritable(record, attempt.attemptId);
  if (writable !== 'active') {
    if (writable !== 'stale')
      try {
        await del(pathname, { abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
      } catch (error) {
        console.error('checkpoint_cleanup_failed', { snapshotId: attempt.id, error });
      }
    throw rejectedCheckpoint(writable);
  }
  return pathname;
}

export async function loadCheckpoint(attempt: JobAttempt): Promise<Snapshot | null> {
  const raw = await redis().get(key(`checkpoint:${attempt.id}`));
  if (!raw) return null;
  const record = checkpointRecordSchema.parse(raw);
  if (record.id !== attempt.id) throw new Error('Checkpoint identity mismatch');
  if (
    record.state === 'retired' ||
    (await checkpointWritable(record, attempt.attemptId)) !== 'active'
  )
    return null;
  const bytes = await readArtifact(checkpointPath(record));
  if (!bytes) return null;
  const snapshot = parseSnapshot(
    JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_ARTIFACT }).toString('utf8')),
  );
  if (snapshot.id !== attempt.id || snapshot.repository.slug.toLowerCase() !== record.slug)
    throw new Error('Checkpoint identity mismatch');
  return (await checkpointWritable(record, attempt.attemptId)) === 'active' ? snapshot : null;
}

export const PUBLISH_SCRIPT = `
local observedAt = tonumber(ARGV[3])
if ARGV[6] and ARGV[6] ~= '' then
  local raw = redis.call('GET', KEYS[7])
  if not raw then return 'stale' end
  local context = cjson.decode(raw)
  local lease = tonumber(redis.call('ZSCORE', KEYS[8], ARGV[2]) or '0')
  if context.attemptId ~= ARGV[6] or lease <= tonumber(ARGV[7]) then return 'stale' end
  local job = redis.call('GET', KEYS[9])
  if not job then return 'stale' end
  local state = cjson.decode(job).state
  if state ~= 'queued' and state ~= 'running' then return 'stale' end
  observedAt = context.observedAt
end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'removed' end
redis.call('SET', KEYS[1], ARGV[1], 'NX')
local previous = tonumber(redis.call('GET', KEYS[3]) or '-1')
if ARGV[9] ~= '0' and observedAt >= previous then
  redis.call('SET', KEYS[2], ARGV[2])
  redis.call('SET', KEYS[3], observedAt)
end
if ARGV[4] == '1' then redis.call('SADD', KEYS[5], ARGV[5]) end
redis.call('SADD', KEYS[6], ARGV[2])
if ARGV[6] and ARGV[6] ~= '' then
  redis.call('SET', KEYS[9], ARGV[8], 'EX', 604800)
  redis.call('ZREM', KEYS[8], ARGV[2])
end
return 'published'
`;

export async function publishSnapshot(
  value: Snapshot,
  options: { gallery?: boolean; latest?: boolean; observedAt?: number; attempt?: JobAttempt } = {},
): Promise<Manifest> {
  const snapshot = parseSnapshot(value);
  const slug = snapshot.repository.slug.toLowerCase();
  await assertVisible(slug, true);
  const store = redis();
  const gallery = Boolean(
    options.gallery && GALLERY.some((item) => item.slug.toLowerCase() === slug),
  );
  const existing = await store.get(key(`manifest:${slug}:${snapshot.id}`));
  if (existing) {
    const manifest = manifestSchema.parse(existing);
    await promoteManifest(
      manifest,
      options.observedAt ?? Date.parse(snapshot.generatedAt),
      gallery,
      options.attempt,
      options.latest,
    );
    return manifest;
  }
  await registerSnapshot(slug, snapshot.id);
  const bytes = gzipSync(JSON.stringify(snapshot));
  const digest = hash(bytes);
  const pathname = artifactPath(slug, snapshot.id, digest);
  if (bytes.length > MAX_ARTIFACT) throw new Error('Snapshot artifact exceeds the storage limit');
  const written = [pathname, ...PARTS.map((part) => partPath(slug, snapshot.id, digest, part))];
  try {
    await putArtifact(pathname, bytes, 'application/gzip');
    await writeParts(slug, snapshot, digest);
    await rejectRemovedWrite(slug, written);
    const meta = snapshotMetaSchema.parse(snapshot);
    const manifest = manifestSchema.parse({
      ...meta,
      artifact: { pathname, sha256: hash(bytes), bytes: bytes.length },
    });
    await promoteManifest(
      manifest,
      options.observedAt ?? Date.parse(snapshot.generatedAt),
      gallery,
      options.attempt,
      options.latest,
    );
  } finally {
    await rejectRemovedWrite(slug, written);
  }
  return manifestSchema.parse(await store.get(key(`manifest:${slug}:${snapshot.id}`)));
}

export async function promoteManifest(
  manifest: Manifest,
  observedAt: number,
  gallery = false,
  attempt?: JobAttempt,
  latest = true,
): Promise<void> {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0)
    throw new Error('Invalid repository observation time');
  if (attempt && attempt.id !== manifest.id)
    throw new Error('Publication attempt identity mismatch.');
  const slug = manifest.repository.slug.toLowerCase();
  const result = await redis().eval(
    PUBLISH_SCRIPT,
    [
      key(`manifest:${slug}:${manifest.id}`),
      key(`latest:${slug}`),
      key(`fence:${slug}`),
      key(`removed:${slug}`),
      key('gallery'),
      key(`snapshots:${slug}`),
      key(`context:${manifest.id}`),
      key('leases'),
      key(`job:${manifest.id}`),
    ],
    [
      JSON.stringify(manifest),
      manifest.id,
      observedAt,
      gallery ? '1' : '0',
      slug,
      attempt?.attemptId ?? '',
      Date.now(),
      JSON.stringify({
        id: manifest.id,
        slug,
        state: 'ready',
        snapshotId: manifest.id,
        updatedAt: new Date().toISOString(),
      }),
      latest ? '1' : '0',
    ],
  );
  if (result === 'stale') throw new Error('Repository processing attempt is no longer active.');
  if (result === 'removed')
    throw new PublicError('This repository has been removed from Lore.', 410);
}

export async function readManifest(slug: string, id?: string): Promise<Manifest | null> {
  repositorySlugSchema.parse(slug);
  await assertVisible(slug);
  const store = redis();
  const selected = id
    ? snapshotIdSchema.parse(id)
    : z
        .string()
        .nullable()
        .parse(await store.get(key(`latest:${slug}`)));
  if (!selected) return null;
  const raw = await store.get(key(`manifest:${slug}:${selected}`));
  if (!raw) return null;
  const manifest = manifestSchema.parse(raw);
  if (
    manifest.repository.slug.toLowerCase() !== slug ||
    manifest.id !== selected ||
    manifest.artifact.pathname !== artifactPath(slug, selected, manifest.artifact.sha256)
  )
    throw new Error('Snapshot manifest identity mismatch');
  return manifest;
}

/**
 * One stored part, gzip compressed. A snapshot published before the parts existed converts from
 * its JSON on its first read and keeps the result, so later reads are a plain fetch. The first
 * reader takes a short lock and the rest wait for its writes instead of converting too.
 */
const CONVERT_LOCK_MS = 60_000;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
`;

function conversionLock(slug: string, id: string, digest: string): string {
  return key(`parts:${slug}:${id}:${digest}`);
}

async function releaseConversionLock(lock: string, token: string): Promise<void> {
  try {
    await redis().eval(RELEASE_LOCK_SCRIPT, [lock], [token]);
  } catch {
    // The lock expires on its own, so a failed release only delays the next reader.
  }
}

/**
 * A part may have been written a moment ago by another instance, so a CDN miss falls back to the
 * origin before the reader decides to convert.
 */
async function readStoredPart(pathname: string): Promise<Buffer | null> {
  return (await readArtifact(pathname, true)) ?? readArtifact(pathname);
}

export async function readSnapshotPart(
  slug: string,
  id: string,
  part: Part,
  version: string,
): Promise<Buffer | null> {
  const manifest = await readManifest(slug, id);
  if (!manifest || version !== partVersion(manifest)) return null;
  const digest = manifest.artifact.sha256;
  const pathname = partPath(slug, id, digest, part);
  const stored = await readStoredPart(pathname);
  if (stored) return stored;
  const lock = conversionLock(slug, id, digest);
  const token = randomUUID();
  const deadline = Date.now() + CONVERT_LOCK_MS * 2;
  for (;;) {
    if ((await redis().set(lock, token, { nx: true, px: CONVERT_LOCK_MS })) === 'OK') {
      try {
        const raced = await readStoredPart(pathname);
        if (raced) return raced;
        const data = await readSnapshotData(slug, id);
        if (!data) return null;
        const parts = await writeParts(slug, { ...data.snapshot, eras: manifest.eras }, digest);
        await rejectRemovedWrite(
          slug,
          PARTS.map((name) => partPath(slug, id, digest, name)),
        );
        return parts[part];
      } finally {
        await releaseConversionLock(lock, token);
      }
    }
    if (Date.now() > deadline) throw new Error('Snapshot conversion is taking too long.');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await readStoredPart(pathname);
    if (result) return result;
  }
}

export async function readSnapshotData(
  slug: string,
  id: string,
): Promise<{ snapshot: Snapshot; bytes: Buffer } | null> {
  const manifest = await readManifest(slug, id);
  if (!manifest) return null;
  const bytes = await readArtifact(manifest.artifact.pathname, true);
  if (!bytes) return null;
  if (bytes.length !== manifest.artifact.bytes || hash(bytes) !== manifest.artifact.sha256)
    throw new Error('Snapshot artifact checksum mismatch');
  const snapshot = parseSnapshot(
    JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_ARTIFACT }).toString('utf8')),
  );
  if (
    snapshot.id !== id ||
    snapshot.repository.slug.toLowerCase() !== slug ||
    snapshot.repository.head !== manifest.repository.head
  )
    throw new Error('Snapshot artifact identity mismatch');
  return { snapshot, bytes };
}

export const REMOVE_REPOSITORY_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'NX')
redis.call('SREM', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[3], KEYS[4], KEYS[5], KEYS[7], KEYS[8])
return redis.call('SMEMBERS', KEYS[6])
`;

async function keysMatching(pattern: string): Promise<string[]> {
  const store = redis();
  const found = new Set<string>();
  let cursor = '0';
  do {
    const result: [string, string[]] = await store.scan(cursor, { match: pattern, count: 1000 });
    cursor = result[0];
    for (const name of result[1]) found.add(name);
  } while (String(cursor) !== '0');
  return [...found];
}

async function deleteBlobPrefix(prefix: string): Promise<void> {
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: blobPath(prefix), cursor, limit: 1000 });
    paths.push(...page.blobs.map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  for (let index = 0; index < paths.length; index += 1000)
    await del(paths.slice(index, index + 1000));
}

export async function removeRepository(value: string): Promise<void> {
  const slug = repositorySlugSchema.parse(value).toLowerCase();
  const store = redis();
  const retainedSnapshotIds = z
    .array(snapshotIdSchema)
    .parse(
      await store.eval(
        REMOVE_REPOSITORY_SCRIPT,
        [
          key(`removed:${slug}`),
          key('gallery'),
          key(`visible:${slug}`),
          key(`latest:${slug}`),
          key(`fence:${slug}`),
          key(`snapshots:${slug}`),
          key(`seen:${slug}`),
          key(`missing:${slug}`),
        ],
        [new Date().toISOString(), slug],
      ),
    );
  for (const id of retainedSnapshotIds) {
    await store.del(key(`context:${id}`));
    const metadata = await keysMatching(key(`narration:${id}:*`));
    metadata.push(...(await keysMatching(key(`command:${id}:*`))));
    metadata.push(
      key(`manifest:${slug}:${id}`),
      key(`job:${id}`),
      key(`context:${id}`),
      key(`command:${id}`),
      key(`charged:${id}`),
    );
    await store.del(...metadata);
    await store.zrem(key('leases'), id);
  }
  await deleteBlobPrefix(`snapshots/${slug}/`);
  await deleteBlobPrefix(`manifests/${slug}/`);
  for (const member of await store.smembers(key(`checkpoints:${slug}`))) {
    await store.del(key(`checkpoint:${member}`));
    await store.zrem(key('checkpoints'), member);
  }
  await deleteBlobPrefix(`checkpoints/${slug}/`);
  for (const id of retainedSnapshotIds) await del(blobPath(`checkpoints/${id}.json.gz`));
  const manifests = await keysMatching(key(`manifest:${slug}:*`));
  if (manifests.length) await store.del(...manifests);
}
