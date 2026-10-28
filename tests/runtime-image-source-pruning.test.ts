import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('runtime image source pruning', () => {
  it('prunes every test module extension and test-only helper before the runner copy', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    const pruneStep = 'RUN node scripts/prune-runtime-source.mjs src';
    const runnerCopy = 'COPY --chown=bun:bun --from=builder /app/src ./src';

    expect(dockerfile).toContain(pruneStep);
    expect(dockerfile.indexOf(pruneStep)).toBeLessThan(
      dockerfile.indexOf('FROM oven/bun:1.4.2-slim AS runner')
    );
    expect(dockerfile.indexOf(pruneStep)).toBeLessThan(dockerfile.indexOf(runnerCopy));

    const root = mkdtempSync(join(tmpdir(), 'runtime-source-'));
    const source = join(root, 'src');
    mkdirSync(join(source, 'lib', 'testing'), { recursive: true });
    mkdirSync(join(source, 'lib', 'test-support'), { recursive: true });
    mkdirSync(join(source, 'feature'), { recursive: true });

    const removed = [
      'feature/unit.test.ts',
      'feature/component.test.tsx',
      'feature/protocol.test.mts',
      'feature/fixture.test.mjs',
      'feature/types.test.d.ts',
      'feature/output.test.ts.snap',
      'feature/unit.spec.js',
      'lib/testing/helper.ts',
      'lib/test-support/seed.ts',
    ];
    const retained = ['feature/runtime.ts', 'feature/contest.ts', 'lib/runtime.ts'];

    for (const file of [...removed, ...retained]) {
      const path = join(source, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'export {};\n');
    }

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'prune-runtime-source.mjs'), source],
      { encoding: 'utf8' }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(removed.filter((file) => existsSync(join(source, file)))).toEqual([]);
    expect(retained.filter((file) => existsSync(join(source, file)))).toEqual(retained);
  });
});
