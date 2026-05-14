import type { DemoState } from '../domain/types';
import {
  runPostgresMigrations,
  type PostgresMigrationFile,
  type PostgresMigrationRunOptions,
  type PostgresMigrationRunReport
} from './postgresMigrationRunner';
import {
  runPostgresSeedImport,
  type PostgresSeedImportOptions,
  type PostgresSeedImportReport
} from './postgresSeedImport';
import {
  runPostgresStateSmoke,
  type PostgresStateSmokeOptions,
  type PostgresStateSmokeReport
} from './postgresStateSmoke';
import type { PostgresStateDatabase } from './postgresStateStore';

export type PostgresCutoverStepName = 'migration' | 'seed' | 'smoke';
export type PostgresCutoverStepStatus = 'passed' | 'failed' | 'skipped';

export interface PostgresCutoverStep {
  name: PostgresCutoverStepName;
  status: PostgresCutoverStepStatus;
  summary: string;
  report?: PostgresMigrationRunReport | PostgresSeedImportReport | PostgresStateSmokeReport;
}

export interface PostgresCutoverReport {
  ok: boolean;
  apply: boolean;
  tenantId: string;
  runtimeSwitch: 'unchanged';
  steps: PostgresCutoverStep[];
}

export interface PostgresCutoverOptions {
  db: PostgresStateDatabase;
  state: DemoState;
  migrations: PostgresMigrationFile[];
  tenantId: string;
  apply: boolean;
  replace?: boolean;
  runMigrations?: (options: PostgresMigrationRunOptions) => Promise<PostgresMigrationRunReport>;
  runSeed?: (options: PostgresSeedImportOptions) => Promise<PostgresSeedImportReport>;
  runSmoke?: (options: PostgresStateSmokeOptions) => Promise<PostgresStateSmokeReport>;
}

export async function runPostgresCutover(options: PostgresCutoverOptions): Promise<PostgresCutoverReport> {
  const runMigrations = options.runMigrations ?? runPostgresMigrations;
  const runSeed = options.runSeed ?? runPostgresSeedImport;
  const runSmoke = options.runSmoke ?? runPostgresStateSmoke;
  const steps: PostgresCutoverStep[] = [];

  const migration = await runMigrations({
    db: options.db,
    migrations: options.migrations,
    apply: options.apply
  });
  steps.push({
    name: 'migration',
    status: migration.ok ? 'passed' : 'failed',
    summary: summarizeMigration(migration),
    report: migration
  });

  if (!migration.ok) {
    steps.push(skippedStep('seed', 'migration failed'));
    steps.push(skippedStep('smoke', 'migration failed'));
    return buildReport(options, steps);
  }

  const seed = await runSeed({
    db: options.db,
    state: options.state,
    tenantId: options.tenantId,
    apply: options.apply,
    replace: options.replace
  });
  steps.push({
    name: 'seed',
    status: seed.ok ? 'passed' : 'failed',
    summary: summarizeSeed(seed),
    report: seed
  });

  if (!seed.ok) {
    steps.push(skippedStep('smoke', 'seed failed'));
    return buildReport(options, steps);
  }

  if (!options.apply) {
    steps.push(skippedStep('smoke', 'dry-run mode'));
    return buildReport(options, steps);
  }

  const smoke = await runSmoke({
    db: options.db,
    expectedState: options.state,
    tenantId: options.tenantId
  });
  steps.push({
    name: 'smoke',
    status: smoke.ok ? 'passed' : 'failed',
    summary: smoke.ok ? 'parity smoke passed' : 'parity smoke failed',
    report: smoke
  });

  return buildReport(options, steps);
}

function buildReport(options: PostgresCutoverOptions, steps: PostgresCutoverStep[]): PostgresCutoverReport {
  return {
    ok: steps.every((step) => step.status !== 'failed'),
    apply: options.apply,
    tenantId: options.tenantId,
    runtimeSwitch: 'unchanged',
    steps
  };
}

function skippedStep(name: PostgresCutoverStepName, summary: string): PostgresCutoverStep {
  return { name, status: 'skipped', summary };
}

function summarizeMigration(report: PostgresMigrationRunReport): string {
  if (!report.ok) {
    const failed = report.migrations.find((migration) => migration.status === 'failed');
    return failed?.error ? `failed: ${failed.error}` : 'failed';
  }

  if (report.apply) {
    return `${report.appliedCount} applied now, ${report.pendingCount} pending`;
  }

  return `${report.pendingCount} pending migrations`;
}

function summarizeSeed(report: PostgresSeedImportReport): string {
  if (!report.ok) {
    return report.error ? `failed: ${report.error}` : 'failed';
  }

  return `${report.totalRows} rows ${report.apply ? 'imported' : 'validated'}`;
}
