import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shaSchema } from '../../src/lib/schema';

const run = promisify(execFile);

export function precomputePolicy({ head, publish }: { head?: string; publish: boolean }) {
  if (head) {
    if (publish)
      throw new Error(
        'Pinned offline analysis cannot publish. Refresh the default branch to publish.',
      );
    return { kind: 'pinned', head: shaSchema.parse(head) } as const;
  }
  return { kind: 'refresh' } as const;
}

export async function refreshDefaultBranch(directory: string, branch: string): Promise<string> {
  const source = `refs/heads/${branch}`;
  const target = 'refs/lore/precompute/default';
  await run('git', ['check-ref-format', source]);
  await run(
    'git',
    ['--git-dir', directory, 'fetch', '--no-tags', '--force', 'origin', `+${source}:${target}`],
    {
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const head = shaSchema.parse(
    (
      await run('git', ['--git-dir', directory, 'rev-parse', '--verify', `${target}^{commit}`])
    ).stdout.trim(),
  );
  const remote = (
    await run('git', ['--git-dir', directory, 'ls-remote', '--symref', 'origin', 'HEAD'])
  ).stdout;
  const lines = remote.trim().split('\n');
  if (!lines.includes(`ref: ${source}\tHEAD`) || !lines.includes(`${head}\tHEAD`))
    throw new Error('The remote default branch changed during refresh. Run precompute again.');
  return head;
}
