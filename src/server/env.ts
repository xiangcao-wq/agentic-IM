import { readFile } from 'node:fs/promises';

export async function loadLocalEnvFile(path = '.env.local'): Promise<Record<string, string>> {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }

  const parsed: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = stripEnvQuotes(trimmed.slice(separator + 1).trim());
    parsed[key] = value;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return parsed;
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
