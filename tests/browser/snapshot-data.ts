import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A directory of published snapshot JSON files, such as a precompute `.cache/gallery`. The browser
 * specs read their independent commit and file source here instead of through the app.
 */
export const snapshotDirectory = process.env.LORE_SNAPSHOT_JSON_DIR;

export const snapshotSkipReason =
  'Set LORE_SNAPSHOT_JSON_DIR to a directory of published snapshot JSON files (for example a precompute .cache/gallery) to run this against real artifacts.';

export function snapshotJsonPath(slug: string): string {
  if (!snapshotDirectory) throw new Error(snapshotSkipReason);
  const prefix = `${slug.toLowerCase().replace('/', '-')}-`;
  const names = readdirSync(snapshotDirectory).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.json') && !name.endsWith('.result.json'),
  );
  const name = names.find((candidate) => candidate.includes('-spectral-')) ?? names.sort()[0];
  if (!name) throw new Error(`No snapshot JSON for ${slug} in LORE_SNAPSHOT_JSON_DIR.`);
  return join(snapshotDirectory, name);
}

export function readSnapshotJson(slug: string): unknown {
  return JSON.parse(readFileSync(snapshotJsonPath(slug), 'utf8'));
}

export function touchedBy(
  snapshot: { commits: { sha: string }[]; files: { touches?: number[] }[] },
  sha: string,
): { commit: number; touched: number[] } {
  const commit = snapshot.commits.findIndex((commit) =>
    commit.sha.toLowerCase().startsWith(sha.toLowerCase()),
  );
  const touched = snapshot.files.flatMap((file, index) =>
    (file.touches ?? []).includes(commit) ? [index] : [],
  );
  return { commit, touched };
}
