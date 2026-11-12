import { z } from 'zod';
import { repositorySchema, repositorySlugSchema, shaSchema, type Repository } from '@/lib/schema';
import { parseRepository } from '@/lib/repository';
import { ConfigurationError, PublicError } from './config';

export { parseRepository };

export class RateLimited extends PublicError {
  constructor() {
    super('github is rate limiting lore, try again in a few minutes', 503);
  }
}

export const ACCESS_HEADER = 'x-lore-access';
export type Denial = 'missing' | 'rate-limited' | 'unreachable' | 'not-configured';

export function denial(error: unknown): Denial {
  if (error instanceof RateLimited) return 'rate-limited';
  if (!(error instanceof PublicError)) throw error;
  if (error instanceof ConfigurationError) return 'not-configured';
  if ([403, 404, 410].includes(error.status)) return 'missing';
  if (error.status === 503) return 'unreachable';
  throw error;
}

/**
 * A 403 signals a throttle only when GitHub says so. A blocked or disabled repository also answers
 * 403, and treating that as a throttle would keep serving it from the seen marker for a week.
 */
function throttled(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after')))
  );
}

async function refuse(response: Response): Promise<never> {
  await response.body?.cancel();
  if (response.status === 401 || response.status === 404)
    throw new PublicError('This repository is unavailable or private.', 404);
  if (throttled(response)) throw new RateLimited();
  if (response.status === 403)
    throw new PublicError('This repository is unavailable or private.', 404);
  throw new Error(`GitHub answered ${response.status}.`);
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 12_000;
const gitHeaders = { 'Git-Protocol': 'version=2' };

async function readBounded(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('GitHub response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function packetLines(bytes: Uint8Array): (string | null)[] {
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Oversized Git response.');
  const lines: (string | null)[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let offset = 0; offset < bytes.length;) {
    const header = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/i.test(header)) throw new Error('Invalid Git packet header.');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      lines.push(null);
      offset += 4;
      continue;
    }
    if (length < 5 || length > 65520 || offset + length > bytes.length)
      throw new Error('Invalid Git packet length.');
    const line = decoder.decode(bytes.subarray(offset + 4, offset + length));
    if (!line.endsWith('\n') || /[\0\r\n]/.test(line.slice(0, -1)))
      throw new Error('Invalid Git packet line.');
    lines.push(line.slice(0, -1));
    offset += length;
  }
  if (lines.at(-1) !== null) throw new Error('Unterminated Git response.');
  return lines;
}

function validBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 1024 &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')) &&
    !branch.endsWith('.')
  );
}

export function parseGitHead(bytes: Uint8Array): Pick<Repository, 'head' | 'branch'> {
  const lines = packetLines(bytes);
  if (lines.slice(0, -1).some((line) => line === null)) throw new Error('Unexpected Git flush.');
  const heads = lines.filter((line) => line?.split(' ')[1] === 'HEAD');
  if (heads.length !== 1)
    throw new PublicError('This repository has no readable default-branch history.', 422);
  const match = /^(?:([a-f0-9]{40}|[a-f0-9]{64})) HEAD symref-target:refs\/heads\/(.+)$/.exec(
    heads[0] ?? '',
  );
  if (!match) throw new Error('Invalid Git HEAD.');
  const [, head, branch] = match;
  if (!head || !branch || !validBranch(branch)) throw new Error('Invalid Git default branch.');
  return { head: shaSchema.parse(head), branch };
}

type GitEndpoint = 'info/refs?service=git-upload-pack' | 'git-upload-pack';

function canonicalRedirect(location: string, current: string, endpoint: GitEndpoint): string {
  const url = new URL(location, current);
  const suffix = endpoint.split('?')[0];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search !== (endpoint.startsWith('info/') ? '?service=git-upload-pack' : '') ||
    !url.pathname.endsWith(`.git/${suffix}`)
  )
    throw new Error('Invalid GitHub repository redirect.');
  return parseRepository(url.pathname.slice(1, -`.git/${suffix}`.length));
}

async function gitRequest(
  slug: string,
  endpoint: GitEndpoint,
  body?: string,
): Promise<{ response: Response; slug: string }> {
  const signal = AbortSignal.timeout(GIT_TIMEOUT_MS);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const url = `https://github.com/${slug}.git/${endpoint}`;
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? {
            ...gitHeaders,
            'Content-Type': 'application/x-git-upload-pack-request',
            Accept: 'application/x-git-upload-pack-result',
          }
        : gitHeaders,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal,
    });
    if (![301, 302, 307, 308].includes(response.status)) return { response, slug };
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('Missing GitHub redirect destination.');
    slug = canonicalRedirect(location, url, endpoint);
  }
  throw new Error('Too many GitHub redirects.');
}

export async function canonicalName(slug: string): Promise<string> {
  const response = await fetch(`https://github.com/${slug}`, {
    method: 'HEAD',
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== 301) return slug;
  const url = new URL(response.headers.get('location') ?? '', 'https://github.com');
  const moved = repositorySlugSchema.safeParse(url.pathname.slice(1));
  if (url.origin !== 'https://github.com' || url.search || url.hash || !moved.success)
    throw new Error('Invalid GitHub repository redirect.');
  return moved.data.toLowerCase();
}

async function discoverRepository(slug: string): Promise<string> {
  const result = await gitRequest(await canonicalName(slug), 'info/refs?service=git-upload-pack');
  const { response } = result;
  if (!response.ok) return refuse(response);
  if (
    !response.headers.get('content-type')?.startsWith('application/x-git-upload-pack-advertisement')
  ) {
    await response.body?.cancel();
    throw new Error('Repository visibility could not be checked.');
  }
  const lines = packetLines(await readBounded(response));
  const start = lines[0] === '# service=git-upload-pack' && lines[1] === null ? 2 : 0;
  if (
    lines[start] !== 'version 2' ||
    !lines.some((line) => line === 'ls-refs' || line?.startsWith('ls-refs='))
  )
    throw new Error('GitHub did not advertise Git protocol v2 ls-refs.');
  return result.slug;
}

async function checkOptOut(slug: string): Promise<void> {
  const response = await fetch(`https://raw.githubusercontent.com/${slug}/HEAD/.lore-ignore`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.ok) throw new PublicError('This repository has opted out of Lore.', 403);
  if (throttled(response)) throw new RateLimited();
  if (response.status === 403)
    throw new PublicError('This repository is unavailable or private.', 404);
  if (response.status !== 404)
    throw new PublicError('The repository opt-out setting could not be checked.', 503);
}

export async function assertPublic(slug: string): Promise<void> {
  slug = parseRepository(repositorySlugSchema.parse(slug));
  try {
    await checkOptOut(await discoverRepository(slug));
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError('Repository visibility could not be checked. Try again shortly.', 503);
  }
}

const metadataSchema = z.object({
  full_name: repositorySlugSchema,
  private: z.boolean(),
  disabled: z.boolean().optional(),
  description: z.string().nullable(),
  stargazers_count: z.number().int().nonnegative(),
});

export type RepositoryDetails = z.infer<typeof metadataSchema>;

export async function repositoryDetails(slug: string): Promise<RepositoryDetails | null> {
  try {
    const token = process.env.GITHUB_TOKEN;
    const response = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'loreof-public-repository-viewer',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed = metadataSchema.safeParse(
      JSON.parse(new TextDecoder().decode(await readBounded(response))),
    );
    return parsed.success && parsed.data.full_name.toLowerCase() === slug ? parsed.data : null;
  } catch {
    return null;
  }
}

const headRequest = '0014command=ls-refs\n0001000csymrefs\n0014ref-prefix HEAD\n0000';

async function resolveHead(slug: string): Promise<Pick<Repository, 'head' | 'branch'>> {
  const { response, slug: canonical } = await gitRequest(slug, 'git-upload-pack', headRequest);
  if (canonical !== slug) {
    await response.body?.cancel();
    throw new Error('Repository moved while resolving HEAD.');
  }
  if (!response.ok) return refuse(response);
  if (!response.headers.get('content-type')?.startsWith('application/x-git-upload-pack-result')) {
    await response.body?.cancel();
    throw new Error('GitHub did not return repository references.');
  }
  return parseGitHead(await readBounded(response));
}

export async function resolveRepository(slug: string): Promise<Repository> {
  slug = parseRepository(repositorySlugSchema.parse(slug));
  try {
    const canonical = await discoverRepository(slug);
    const [{ head, branch }, , details] = await Promise.all([
      resolveHead(canonical),
      checkOptOut(canonical),
      repositoryDetails(canonical),
    ]);
    if (details?.private || details?.disabled)
      throw new PublicError('Only available public repositories can be processed.', 403);
    const [owner, name] = canonical.split('/');
    return repositorySchema.parse({
      owner,
      name,
      slug: canonical,
      head,
      branch,
      description: details?.description ?? '',
      stars: details?.stargazers_count ?? 0,
    });
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError('GitHub could not be reached. Try again shortly.', 503);
  }
}
