import { runAnalysis } from './analysis-runner';

runAnalysis(process.cwd()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
