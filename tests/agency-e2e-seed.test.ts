import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const seed = readFileSync(resolve('scripts/seed-agency-e2e.ts'), 'utf8');
const runner = readFileSync(resolve('scripts/run-agency-e2e.ts'), 'utf8');
const preflight = readFileSync(resolve('scripts/preflight-agency-e2e.ts'), 'utf8');
const fixture = readFileSync(resolve('tests/agency-e2e/agency-fixture.ts'), 'utf8');

describe('Agency E2E owned fixture restoration', () => {
  test('licenses Notes for the agency demo package', () => {
    expect(seed).toContain("['notes', 'Notes', 'Knowledge', '/notes', true]");
    expect(seed).toContain("['api', 'API access', 'Developer', '/organization/api', false]");
    expect(seed).toContain("['webhooks', 'Webhooks', 'Developer', '/organization/webhooks', false]");
    expect(seed).toContain('update: { enabled }');
    expect(seed).toMatch(/create: \{[\s\S]*?enabled,[\s\S]*?\}/);
    expect(seed).toMatch(
      /platformPackageModule\.findFirst\([\s\S]*?module: \{ key: 'notes' \}[\s\S]*?if \(!notesLicense\?\.enabled\)/
    );
  });

  test('uses exact owned IDs and restores the seed twice before execution', () => {
    expect(fixture).toContain("organizationId: 'org_agency_e2e_owned'");
    expect(fixture).toContain("clientId: 'client_agency_e2e_owned'");
    expect(fixture).toContain("taskId: 'task_agency_e2e_owned'");
    expect(seed).not.toMatch(/update:\s*\{\s*\}/);
    expect(runner.match(/seed-agency-e2e\.ts/g)).toHaveLength(2);
  });

  test('runs the database safety checks from a caught async entry point', () => {
    expect(seed).toContain('async function main()');
    expect(seed).toMatch(/main\(\)\.catch\(\(error: unknown\) => \{/);
    expect(seed).toContain('console.error(error)');
    expect(seed).toContain('process.exitCode = 1');
    expect(preflight).toContain('async function main()');
    expect(preflight).toMatch(/main\(\)\.catch\(\(error: unknown\) => \{/);
    expect(preflight).toContain('process.exitCode = 1');
    expect(preflight).toContain('LOGIN NOSUPERUSER NOBYPASSRLS');
    expect(preflight).toContain('canonical disposable target');
    expect(preflight).toContain('await pool.end()');
  });

  test.each([
    'organization',
    'user',
    'client',
    'project',
    'board',
    'column',
    'task',
    'meeting',
    'invoice',
    'transaction',
  ])('restores mutable %s values by upsert', (model) => {
    expect(seed).toMatch(new RegExp(`tx\\.${model}\\.upsert\\(\\{[\\s\\S]*?update: \\{`));
  });
});
