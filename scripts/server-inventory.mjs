import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultEnvFile = '/etc/agentbridge/agentbridge.env';
const defaultServiceName = 'agentbridge-api';
const defaultReadinessTimeoutMs = 10_000;

const envKeys = [
  'NODE_ENV',
  'AGENT_IM_PUBLIC_MODE',
  'AGENT_IM_API_PORT',
  'AGENT_IM_API_TOKEN',
  'AGENT_IM_ALLOWED_ORIGINS',
  'AGENT_IM_DB_PATH',
  'AGENT_IM_MEDIA_DIR',
  'MATRIX_BOOTSTRAP_PATH',
  'AGENT_IM_ALLOW_NO_AUTH',
  'AGENT_IM_ALLOW_QUERY_TOKEN',
  'AGENT_IM_AUTOPILOT_WORKER',
  'AGENT_IM_AUTOPILOT_WORKER_INTERVAL_MS',
  'AGENT_IM_AUTOPILOT_WORKER_LIMIT',
  'AGENT_IM_AUTOPILOT_WORKER_RUN_ON_START',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_HUMAN_MODEL',
  'DEEPSEEK_AGENT_MODEL',
  'DEEPSEEK_AGENT_THINKING',
  'DEEPSEEK_AGENT_REASONING_EFFORT'
];

export async function collectServerInventory(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const envFile = options.envFile ?? process.env.AGENTBRIDGE_ENV_FILE ?? defaultEnvFile;
  const serviceName = options.serviceName ?? defaultServiceName;
  const commandRunner = options.commandRunner ?? runCommand;
  const fetchImpl = options.fetchImpl ?? fetch;
  const envFileResult = await readEnvFile(envFile);
  const mergedEnv = {
    ...pickKeys(process.env, envKeys),
    ...envFileResult.values
  };
  const paths = deriveDeploymentPaths(mergedEnv, cwd);

  const report = {
    generatedAt: new Date().toISOString(),
    cwd,
    envFile: {
      path: envFile,
      exists: envFileResult.exists,
      readable: envFileResult.readable,
      error: envFileResult.error
    },
    runtime: await collectRuntime(commandRunner),
    git: await collectGit(cwd, commandRunner),
    service: await collectService(serviceName, commandRunner),
    paths: {
      current: await inspectPath(paths.current),
      releases: await inspectPath(paths.releases),
      stateFile: await inspectPath(paths.stateFile),
      eventLog: await inspectPath(paths.eventLog),
      mediaDir: await inspectPath(paths.mediaDir)
    },
    env: summarizeEnv(mergedEnv),
    readiness: await collectReadiness(options.host, mergedEnv.AGENT_IM_API_TOKEN, fetchImpl, {
      timeoutMs: options.readinessTimeoutMs ?? defaultReadinessTimeoutMs
    })
  };

  return {
    ...report,
    findings: buildFindings(report)
  };
}

export function parseEnvFile(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) {
      values[parsed.key] = parsed.value;
    }
  }
  return values;
}

export function summarizeEnv(env) {
  return Object.fromEntries(envKeys.map((key) => [key, summarizeEnvValue(key, env[key])]));
}

export function deriveDeploymentPaths(env, cwd = process.cwd()) {
  const stateFile = env.AGENT_IM_DB_PATH || join(cwd, 'data', 'agent-im-db.json');
  return {
    current: '/opt/agentbridge/current',
    releases: '/opt/agentbridge/releases',
    stateFile,
    eventLog: deriveEventLogPath(stateFile),
    mediaDir: env.AGENT_IM_MEDIA_DIR || join(cwd, 'data', 'media')
  };
}

export function buildFindings(report) {
  const findings = [];
  const env = report.env;
  const readiness = report.readiness;

  if (env.NODE_ENV.value !== 'production') {
    findings.push('NODE_ENV is not production.');
  }
  if (env.AGENT_IM_PUBLIC_MODE.value !== 'true') {
    findings.push('AGENT_IM_PUBLIC_MODE is not true.');
  }
  if (!env.AGENT_IM_API_TOKEN.configured) {
    findings.push('AGENT_IM_API_TOKEN is not configured.');
  }
  if (env.AGENT_IM_ALLOW_NO_AUTH.value === 'true') {
    findings.push('AGENT_IM_ALLOW_NO_AUTH must not be true for product readiness.');
  }
  if (env.AGENT_IM_ALLOW_QUERY_TOKEN.value === 'true') {
    findings.push('AGENT_IM_ALLOW_QUERY_TOKEN must not be true for product readiness.');
  }
  if (!report.paths.stateFile.exists) {
    findings.push('State file does not exist at the configured path.');
  }
  if (!report.paths.eventLog.exists) {
    findings.push('Agent EventLog file does not exist at the derived path.');
  }
  if (report.service.activeState && report.service.activeState !== 'active') {
    findings.push(`systemd service is not active: ${report.service.activeState}.`);
  }
  if (readiness.host && readiness.noToken.status !== 401 && readiness.noToken.status !== 403) {
    findings.push(`No-token readiness returned ${readiness.noToken.status ?? 'unknown'} instead of 401/403.`);
  }
  if (readiness.host && readiness.queryToken.status !== 401 && readiness.queryToken.status !== 403) {
    findings.push(`Query-token readiness returned ${readiness.queryToken.status ?? 'unknown'} instead of 401/403.`);
  }
  if (readiness.host && readiness.authenticated.status !== 200) {
    findings.push(`Authenticated readiness returned ${readiness.authenticated.status ?? 'unknown'} instead of 200.`);
  }
  if (readiness.authenticated.body?.ok === false) {
    findings.push('/api/readiness reported ok=false.');
  }

  return findings;
}

export function formatInventoryMarkdown(report) {
  const lines = [
    '# AgentBridge Server Inventory',
    '',
    `Generated: ${report.generatedAt}`,
    `Working directory: ${report.cwd}`,
    '',
    '## Runtime',
    '',
    `- Platform: ${formatCommand(report.runtime.platform)}`,
    `- Node: ${formatCommand(report.runtime.node)}`,
    `- npm: ${formatCommand(report.runtime.npm)}`,
    '',
    '## Git',
    '',
    `- Branch: ${formatCommand(report.git.branch)}`,
    `- Commit: ${formatCommand(report.git.commit)}`,
    `- Status: ${formatCommand(report.git.status)}`,
    '',
    '## Service',
    '',
    `- Name: ${report.service.name}`,
    `- Active: ${report.service.activeState ?? 'unknown'}`,
    `- Enabled: ${report.service.enabledState ?? 'unknown'}`,
    `- Fragment: ${report.service.fragmentPath ?? 'unknown'}`,
    `- User: ${report.service.user ?? 'unknown'}`,
    `- Working directory: ${report.service.workingDirectory ?? 'unknown'}`,
    '',
    '## Paths',
    '',
    ...Object.entries(report.paths).map(([name, info]) => `- ${name}: ${formatPathInfo(info)}`),
    '',
    '## Environment',
    '',
    ...Object.entries(report.env).map(([key, value]) => `- ${key}: ${formatEnvSummary(value)}`),
    '',
    '## Readiness',
    '',
    `- Host: ${report.readiness.host ?? 'not provided'}`,
    `- No token: ${formatProbe(report.readiness.noToken)}`,
    `- Query token: ${formatProbe(report.readiness.queryToken)}`,
    `- Authenticated: ${formatProbe(report.readiness.authenticated)}`,
    '',
    '## Findings',
    '',
    ...(report.findings.length > 0 ? report.findings.map((finding) => `- ${finding}`) : ['- No findings from local inventory checks.'])
  ];

  return `${lines.join('\n')}\n`;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }
  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
  const separatorIndex = withoutExport.indexOf('=');
  if (separatorIndex <= 0) {
    return undefined;
  }
  const key = withoutExport.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }
  let value = withoutExport.slice(separatorIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
  }
  return { key, value };
}

async function readEnvFile(path) {
  if (!existsSync(path)) {
    return { exists: false, readable: false, values: {} };
  }
  try {
    return {
      exists: true,
      readable: true,
      values: parseEnvFile(await readFile(path, 'utf8'))
    };
  } catch (error) {
    return {
      exists: true,
      readable: false,
      values: {},
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function pickKeys(env, keys) {
  return Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

function summarizeEnvValue(key, value) {
  if (value === undefined || value === '') {
    return { configured: false };
  }
  if (isSecretKey(key)) {
    return {
      configured: true,
      redacted: true,
      length: String(value).length
    };
  }
  return {
    configured: true,
    value: String(value)
  };
}

function isSecretKey(key) {
  return /(^|_)(API_TOKEN|ACCESS_TOKEN|API_KEY|PRIVATE_KEY|SECRET|PASSWORD|CREDENTIAL)($|_)/i.test(key);
}

function deriveEventLogPath(stateFile) {
  if (stateFile.startsWith('/')) {
    return posix.join(posix.dirname(stateFile), 'agent-events.jsonl');
  }
  return join(dirname(resolve(stateFile)), 'agent-events.jsonl');
}

async function collectRuntime(commandRunner) {
  const [platform, node, npm] = await Promise.all([
    commandRunner('uname', ['-a']),
    commandRunner('node', ['--version']),
    commandRunner('npm', ['--version'])
  ]);
  return { platform, node, npm };
}

async function collectGit(cwd, commandRunner) {
  const [branch, commit, status] = await Promise.all([
    commandRunner('git', ['branch', '--show-current'], { cwd }),
    commandRunner('git', ['rev-parse', 'HEAD'], { cwd }),
    commandRunner('git', ['status', '--short', '--branch'], { cwd })
  ]);
  return { branch, commit, status };
}

async function collectService(name, commandRunner) {
  const [active, enabled, show] = await Promise.all([
    commandRunner('systemctl', ['is-active', name]),
    commandRunner('systemctl', ['is-enabled', name]),
    commandRunner('systemctl', [
      'show',
      name,
      '--property=ActiveState',
      '--property=UnitFileState',
      '--property=FragmentPath',
      '--property=User',
      '--property=WorkingDirectory',
      '--property=ExecStart'
    ])
  ]);
  const properties = parseSystemctlProperties(show.stdout);
  return {
    name,
    activeState: properties.ActiveState || normalizeCommandValue(active),
    enabledState: properties.UnitFileState || normalizeCommandValue(enabled),
    fragmentPath: properties.FragmentPath,
    user: properties.User,
    workingDirectory: properties.WorkingDirectory,
    execStart: sanitizeCommandOutput(properties.ExecStart)
  };
}

async function inspectPath(path) {
  try {
    const info = await lstat(path);
    const result = {
      path,
      exists: true,
      type: info.isSymbolicLink()
        ? 'symlink'
        : info.isDirectory()
          ? 'directory'
          : info.isFile()
            ? 'file'
            : 'other',
      size: info.size,
      mtime: info.mtime.toISOString()
    };
    if (info.isSymbolicLink()) {
      try {
        result.realPath = await realpath(path);
      } catch (error) {
        result.realPathError = error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  } catch (error) {
    return {
      path,
      exists: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function collectReadiness(host, token, fetchImpl, options) {
  const normalizedHost = host?.replace(/\/+$/, '');
  if (!normalizedHost) {
    return {
      host: undefined,
      noToken: { skipped: true, reason: 'host not provided' },
      queryToken: { skipped: true, reason: 'host not provided' },
      authenticated: { skipped: true, reason: 'host not provided' }
    };
  }

  const noToken = await fetchReadinessProbe(fetchImpl, `${normalizedHost}/api/readiness`, {}, token, options);
  const queryToken = token
    ? await fetchReadinessProbe(
        fetchImpl,
        `${normalizedHost}/api/readiness?agent_im_token=${encodeURIComponent(token)}`,
        {},
        token,
        options
      )
    : { skipped: true, reason: 'token not configured' };
  const authenticated = token
    ? await fetchReadinessProbe(
        fetchImpl,
        `${normalizedHost}/api/readiness`,
        { headers: { 'x-agent-im-token': token } },
        token,
        options
      )
    : { skipped: true, reason: 'token not configured' };

  return {
    host: normalizedHost,
    noToken,
    queryToken,
    authenticated
  };
}

async function fetchReadinessProbe(fetchImpl, url, init, token, options) {
  const controller = options.timeoutMs > 0 ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  try {
    const requestInit = controller ? { ...init, signal: controller.signal } : init;
    const response = await fetchImpl(url, requestInit);
    const body = await readJsonResponse(response);
    return {
      status: response.status,
      ok: response.ok,
      body: summarizeReadinessBody(body)
    };
  } catch (error) {
    return {
      error: sanitize(String(error instanceof Error ? error.message : error), token)
    };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: 'response was not JSON' };
  }
}

function summarizeReadinessBody(body) {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const checks = body.checks && typeof body.checks === 'object' ? body.checks : {};
  return {
    ok: body.ok,
    checks: Object.fromEntries(
      Object.entries(checks).map(([name, check]) => [
        name,
        {
          ok: check?.ok,
          status: check?.status,
          mode: check?.mode,
          health: check?.health,
          readable: check?.readable,
          writable: check?.writable,
          valid: check?.valid
        }
      ])
    )
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    try {
      execFile(command, args, { cwd: options.cwd, timeout: 10_000 }, (error, stdout, stderr) => {
        resolveCommand({
          command: [command, ...args].join(' '),
          ok: !error,
          stdout: sanitizeCommandOutput(stdout),
          stderr: sanitizeCommandOutput(stderr),
          code: typeof error?.code === 'number' ? error.code : undefined,
          error: error ? sanitizeCommandOutput(error.message) : undefined
        });
      });
    } catch (error) {
      resolveCommand({
        command: [command, ...args].join(' '),
        ok: false,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? sanitizeCommandOutput(error.message) : sanitizeCommandOutput(String(error))
      });
    }
  });
}

function parseSystemctlProperties(raw) {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return index >= 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ''];
      })
  );
}

function normalizeCommandValue(result) {
  return result.stdout.trim() || result.stderr.trim() || undefined;
}

function sanitizeCommandOutput(value) {
  return sanitize(String(value ?? '').trim());
}

function sanitize(value, token) {
  let result = value;
  if (token) {
    result = result.split(token).join('[redacted]');
  }
  return result
    .replace(/(x-agent-im-token\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]')
    .replace(
      /(^|[\s,;])([A-Z0-9_]*(?:API_TOKEN|ACCESS_TOKEN|API_KEY|PRIVATE_KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)([^\s]+)/gi,
      '$1$2[redacted]'
    );
}

function formatCommand(result) {
  if (!result) {
    return 'unknown';
  }
  const output = result.stdout || result.stderr || result.error || '';
  return output || (result.ok ? 'ok' : 'unavailable');
}

function formatPathInfo(info) {
  if (!info.exists) {
    return `${info.path} (missing${info.error ? `: ${info.error}` : ''})`;
  }
  const target = info.realPath ? ` -> ${info.realPath}` : '';
  return `${info.path}${target} (${info.type}, size=${info.size}, mtime=${info.mtime})`;
}

function formatEnvSummary(summary) {
  if (!summary.configured) {
    return 'missing';
  }
  if (summary.redacted) {
    return `configured, redacted, length=${summary.length}`;
  }
  return summary.value;
}

function formatProbe(probe) {
  if (probe.skipped) {
    return `skipped (${probe.reason})`;
  }
  if (probe.error) {
    return `error (${probe.error})`;
  }
  const readiness = probe.body?.ok === undefined ? '' : `, readiness.ok=${probe.body.ok}`;
  return `HTTP ${probe.status}${readiness}`;
}

function parseArgs(argv) {
  const args = {
    envFile: process.env.AGENTBRIDGE_ENV_FILE ?? defaultEnvFile,
    host: process.env.AGENT_IM_DEPLOY_HOST,
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--env-file') {
      args.envFile = argv[index + 1];
      index += 1;
    } else if (arg === '--host') {
      args.host = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: npm run inventory:server -- [--host https://agentbridge.example.com] [--env-file /etc/agentbridge/agentbridge.env] [--json]

Collects a read-only AgentBridge server inventory for deployment planning.

The report redacts TOKEN, KEY, SECRET, PASSWORD, and CREDENTIAL values. Review output before sharing it anyway.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const report = await collectServerInventory({
    envFile: args.envFile,
    host: args.host
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatInventoryMarkdown(report));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
