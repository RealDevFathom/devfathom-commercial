import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const seed = readFileSync(resolve('scripts/seed-agency-e2e.ts'), 'utf8');
const runner = readFileSync(resolve('scripts/run-agency-e2e.ts'), 'utf8');
const fixture = readFileSync(resolve('tests/agency-e2e/agency-fixture.ts'), 'utf8');

describe('Agency E2E owned fixture restoration', () => {
  test('uses exact owned IDs and restores the seed twice before execution', () => {
    expect(fixture).toContain("organizationId: 'org_agency_e2e_owned'");
    expect(fixture).toContain("clientId: 'client_agency_e2e_owned'");
    expect(fixture).toContain("taskId: 'task_agency_e2e_owned'");
    expect(seed).not.toMatch(/update:\s*\{\s*\}/);
    expect(runner.match(/seed-agency-e2e\.ts/g)).toHaveLength(2);
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
