import { createHash } from 'node:crypto';
import { PIPELINE_VERSION, type Repository } from './schema';

export const DEFAULT_LAYOUT = 'spectral';

export function snapshotIdFor(
  repository: Pick<Repository, 'slug' | 'head'>,
  layout: 'force' | 'tree' | 'spectral' = DEFAULT_LAYOUT,
): string {
  return createHash('sha256')
    .update(`${PIPELINE_VERSION}:${repository.slug.toLowerCase()}:${repository.head}:${layout}`)
    .digest('hex')
    .slice(0, 24);
}
