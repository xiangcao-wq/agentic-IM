import { join } from 'node:path';
import { createAiDemoSeedProvider } from './aiDemoSeed';
import { formatCacheProbeReport, runAiCacheProbe, type CacheProbeRouteName } from './aiCacheProbe';
import { loadLocalEnvFile } from './env';

interface CliOptions {
  rounds?: number;
  delayMs?: number;
  routes?: CacheProbeRouteName[];
  json: boolean;
}

await loadLocalEnvFile(join(process.cwd(), '.env.local'));

const cliOptions = parseArgs(process.argv.slice(2));
const { json, ...probeOptions } = cliOptions;

runAiCacheProbe({
  aiProvider: createAiDemoSeedProvider(process.env),
  ...probeOptions
})
  .then((report) => {
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatCacheProbeReport(report));
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--rounds') {
      options.rounds = parseIntegerArg(args[index + 1], '--rounds');
      index += 1;
      continue;
    }
    if (arg === '--delay-ms') {
      options.delayMs = parseIntegerArg(args[index + 1], '--delay-ms');
      index += 1;
      continue;
    }
    if (arg === '--routes') {
      options.routes = parseRoutes(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseIntegerArg(value: string | undefined, flag: string): number {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be an integer.`);
  }
  return parsed;
}

function parseRoutes(value: string | undefined): CacheProbeRouteName[] {
  if (!value) {
    throw new Error('--routes requires a comma-separated value.');
  }
  return value.split(',').map((route) => {
    const trimmed = route.trim();
    if (
      trimmed !== 'deadline' &&
      trimmed !== 'summary' &&
      trimmed !== 'human_reply' &&
      trimmed !== 'agent_chat'
    ) {
      throw new Error(`Unknown cache probe route: ${trimmed}`);
    }
    return trimmed;
  });
}
