import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261026000000_meeting_time_range_check/migration.sql'
  ),
  'utf8'
);

describe('meeting time database invariant', () => {
  it('atomically rejects invalid ranges produced by concurrent partial updates', () => {
    expect(migration).toMatch(
      /CHECK\s*\(\s*"endTime"\s*>\s*"startTime"\s*\)/u
    );
  });
});
