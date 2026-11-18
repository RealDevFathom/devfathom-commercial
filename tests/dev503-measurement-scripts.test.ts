import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { dev503MeasurementEnvironment } from '../scripts/dev503-local-database';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const SCRIPTS = ['scripts/dev503-synthetic-medicines.ts', 'scripts/dev503-measure-page-loads.ts'];

/** Index of the first top-level statement that calls `name()`, or -1. */
function topLevelCallIndex(source: ts.SourceFile, name: string) {
  return source.statements.findIndex((statement) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name
      )
        found = true;
      if (!found && !ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    visit(statement);
    return found;
  });
}

describe('DEV-503 measurement tooling', () => {
  for (const path of SCRIPTS) {
    test(`${path} refuses anything but the guarded disposable E2E database at load`, () => {
      const text = read(path);
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      expect(text).toMatch(
        /import \{ dev503MeasurementEnvironment \} from '\.\/dev503-local-database';/
      );
      const guard = topLevelCallIndex(source, 'dev503MeasurementEnvironment');
      expect(guard).toBeGreaterThanOrEqual(0);
      // The guard runs before the script's work is defined or started.
      expect(guard).toBeLessThan(topLevelCallIndex(source, 'main'));
    });
  }

  const LOCAL = 'postgresql://gate_runtime:local@127.0.0.1:55676/pharmacy_e2e_dev';
  const local = (overrides: Record<string, string | undefined> = {}) => ({
    PHARMACY_E2E: '1',
    PHARMACY_E2E_DATABASE_URL: LOCAL,
    DATABASE_URL: LOCAL,
    PHARMACY_E2E_ADMIN_EMAIL: 'admin@pharmacy-e2e.test',
    PHARMACY_E2E_ADMIN_PASSWORD: 'local-only',
    ...overrides,
  });

  test('accepts only the guarded loopback database, which DATABASE_URL must name', () => {
    expect(dev503MeasurementEnvironment(local()).DATABASE_URL).toBe(new URL(LOCAL).href);
  });

  test('refuses staging-demo mode, even with a staging endpoint the shared guard accepts', () => {
    const staging =
      'postgresql://demo:x@devfathom-staging.abc123.ap-southeast-1.rds.amazonaws.com:5432/app';
    expect(() =>
      dev503MeasurementEnvironment({
        STAGING_DEMO_SEED: '1',
        DEPLOY_ENV: 'staging',
        STAGING_DB_ENDPOINT: 'devfathom-staging.abc123.ap-southeast-1.rds.amazonaws.com',
        STAGING_DEMO_DATABASE_URL: staging,
        DATABASE_URL: staging,
        PHARMACY_E2E_ADMIN_EMAIL: 'admin@pharmacy-e2e.test',
        PHARMACY_E2E_ADMIN_PASSWORD: 'local-only',
      })
    ).toThrow(/STAGING_DEMO_SEED is set/);
    expect(() => dev503MeasurementEnvironment(local({ DEPLOY_ENV: 'staging' }))).toThrow(
      /DEPLOY_ENV is set/
    );
  });

  test('refuses a database host that is not loopback', () => {
    const remote = 'postgresql://gate_runtime:local@db.example.test:55676/pharmacy_e2e_dev';
    expect(() =>
      dev503MeasurementEnvironment(
        local({ PHARMACY_E2E_DATABASE_URL: remote, DATABASE_URL: remote })
      )
    ).toThrow(/must be loopback/);
  });

  test('requires the E2E opt-in and DATABASE_URL equal to the guarded URL', () => {
    expect(() => dev503MeasurementEnvironment(local({ PHARMACY_E2E: undefined }))).toThrow(
      /PHARMACY_E2E=1/
    );
    expect(() => dev503MeasurementEnvironment(local({ DATABASE_URL: undefined }))).toThrow(
      /DATABASE_URL must equal/
    );
  });

  test('the report labels its figures as local synthetic data', () => {
    const report = read('docs/qa/dev-503/performance.md');
    expect(report).toContain('local, synthetic data, not staging');
    for (const result of ['base-dd75b2e4', 'develop-064e8ba0', 'experiment-counter-prefetch']) {
      const json = JSON.parse(read(`docs/qa/dev-503/results/${result}.json`)) as {
        note: string;
        runs: number;
      };
      expect(json.note).toBe('local, synthetic data, not staging');
      expect(json.runs).toBeGreaterThanOrEqual(7);
    }
  });
});
