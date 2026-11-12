import { spawn } from 'node:child_process';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { repositorySchema } from '../lib/schema';
import {
  analysisFailure,
  analysisFailureSchema,
  progressSchema,
  type AnalysisFailure,
  type AnalysisStatus,
} from './analysis-protocol';

const inputSchema = z.object({ repository: repositorySchema });

export async function runAnalysis(root: string): Promise<void> {
  try {
    await (await open(join(root, 'runner.lock'), 'wx')).close();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
    throw error;
  }
  async function report(value: AnalysisStatus) {
    await writeFile(join(root, 'status.tmp'), JSON.stringify(value));
    await rename(join(root, 'status.tmp'), join(root, 'status.json'));
  }
  async function run(cmd: string, args: string[], progress = false): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      let pending = '';
      let stderr = '';
      let failure: AnalysisFailure | undefined;
      let reportError: unknown;
      let reports = Promise.resolve();
      function consume(line: string) {
        try {
          const value = z.union([analysisFailureSchema, progressSchema]).parse(JSON.parse(line));
          if ('kind' in value) failure = value;
          else
            reports = reports
              .then(() => report({ state: 'running', ...value }))
              .catch((error: unknown) => {
                reportError ??= error;
              });
        } catch (error) {
          reportError ??= error;
        }
      }
      child.stdout.on('data', (data: Buffer) => {
        if (!progress) return;
        pending += data.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) consume(line);
        if (pending.length > 16384) {
          reportError ??= new Error('Analysis protocol line exceeds the supported size.');
          pending = '';
          child.kill();
        }
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-2000);
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (pending) consume(pending);
        void reports.then(() => {
          if (reportError) return reject(reportError);
          if (code === 0) return resolve();
          const error = new Error(`${cmd} exited ${code ?? signal}: ${stderr}`);
          if (failure) Object.assign(error, { analysisFailure: failure });
          reject(error);
        });
      });
    });
  }
  try {
    const { repository } = inputSchema.parse(
      JSON.parse(await readFile(join(root, 'input.json'), 'utf8')),
    );
    await report({
      state: 'running',
      stage: 'clone',
      detail: 'Cloning public default-branch history.',
    });
    await run('git', [
      'clone',
      '--bare',
      '--filter=blob:none',
      '--single-branch',
      '--branch',
      repository.branch,
      '--',
      `https://github.com/${repository.slug}.git`,
      join(root, 'repo.git'),
    ]);
    await run('git', [
      `--git-dir=${join(root, 'repo.git')}`,
      'cat-file',
      '-e',
      `${repository.head}^{commit}`,
    ]);
    await report({
      state: 'running',
      stage: 'history',
      detail: 'Reading complete first-parent history.',
    });
    await run(process.execPath, [join(root, 'analysis.mjs')], true);
    await report({ state: 'done' });
  } catch (error) {
    const explicit =
      error instanceof Error && 'analysisFailure' in error
        ? analysisFailureSchema.safeParse(error.analysisFailure)
        : undefined;
    await report({
      state: 'failed',
      failure: explicit?.success ? explicit.data : analysisFailure(error),
    });
  }
}
