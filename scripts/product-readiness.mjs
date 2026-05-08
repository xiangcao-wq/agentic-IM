import { defaultChecks, formatDuration, runReadinessChecks } from './product-readiness-runner.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = new Set(process.argv.slice(2));
const localDemo = args.has('--local-demo');
const help = args.has('--help') || args.has('-h');

if (help) {
  console.log(`Usage: npm run readiness:product -- [--local-demo]

Runs the product readiness gate.

Default checks:
  npm run test
  npm run build
  npm run eval:agent
  npm run eval:agent:real
  npm run smoke:browser
  GET /api/readiness
  npm run infra:smoke

--local-demo skips eval:agent:real and infra:smoke, but still runs browser smoke and /api/readiness.
`);
  process.exit(0);
}

const results = await runReadinessChecks(defaultChecks, {
  localDemo,
  npmCommand: npm,
  env: process.env
});

const failed = results.filter((result) => result.status === 'failed');
const skipped = results.filter((result) => result.status === 'skipped');

console.log('\nProduct readiness summary:');
for (const result of results) {
  const suffix =
    result.status === 'skipped'
      ? ` (${result.reason})`
      : result.status === 'failed'
        ? ` (${formatDuration(result.durationMs)})`
        : ` (${formatDuration(result.durationMs)})`;
  console.log(`- ${result.status.toUpperCase()}: ${result.name}${suffix}`);
}

if (skipped.length > 0) {
  console.log('\nSkipped checks:');
  for (const result of skipped) {
    console.log(`- ${result.script ?? result.name}: skipped for ${result.reason}`);
  }
}

if (failed.length > 0) {
  process.exit(1);
}

if (!localDemo && skipped.length > 0) {
  process.exit(1);
}

process.exit(0);
