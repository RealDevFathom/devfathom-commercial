import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The fixture runtime proof is a node:test file (.mjs), which vitest does not collect on its own.
// Run it under the normal unit command so its failures are not silently skipped.
describe('menu import fixture runtime (node:test)', () => {
  it('passes every case', () => {
    const file = path.join(__dirname, 'menu-import-fixture-runtime.test.mjs');
    const run = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' });
    expect(run.stdout + run.stderr).toMatch(/# fail 0/);
    expect(run.status).toBe(0);
  }, 120_000);
});
