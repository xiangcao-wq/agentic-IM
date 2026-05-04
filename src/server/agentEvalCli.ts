import { join } from 'node:path';
import { runAgentEval } from './agentEval';
import { resolveAgentEvalCliConfig } from './agentEvalCliConfig';
import { createAiDemoSeedProvider } from './aiDemoSeed';
import { loadLocalEnvFile } from './env';

await loadLocalEnvFile(join(process.cwd(), '.env.local'));
const { useRealProvider } = resolveAgentEvalCliConfig(process.argv.slice(2), process.env);
const aiProvider = useRealProvider ? createAiDemoSeedProvider(process.env) : undefined;
const report = await runAgentEval({ aiProvider });

console.log(JSON.stringify(report, null, 2));

if (
  report.thresholds.passRate < 0.9 ||
  report.thresholds.noForbiddenToolPassRate < 1 ||
  report.thresholds.fileAvailabilityPassRate < 1 ||
  report.thresholds.fallbackPassRate < 1
) {
  process.exitCode = 1;
}
