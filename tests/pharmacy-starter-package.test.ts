// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('refuses an incomplete release without replacing the packaged reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-package-'));
  const artifact = join(dir, 'src/lib/pharmacy/migration/starter-products.json');
  const input = {
    sourceId: 'QA',
    legacyCode: null,
    name: 'QA medicine',
    packSize: 1,
    class: null,
    verifiedGeneric: null,
    manufacturerLabel: null,
    active: true,
    controlled: false,
  };
  try {
    mkdirSync(join(dir, 'src/lib/pharmacy/migration'), { recursive: true });
    writeFileSync(artifact, 'null\n');
    writeFileSync(join(dir, 'approved.json'), JSON.stringify([input]));
    writeFileSync(join(dir, 'reviewed.json'), '[]');
    expect(() =>
      execFileSync(
        'bun',
        [resolve('scripts/qa/build-pharmacy-starter.ts'), 'approved.json', 'reviewed.json'],
        { cwd: dir, stdio: 'pipe' }
      )
    ).toThrow(/Catalogue counts differ from the approved Abuzar inspection/);
    expect(readFileSync(artifact, 'utf8')).toBe('null\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
