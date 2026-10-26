import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');

function listFiles(directory: string, relativeDirectory = ''): string[] {
  return readdirSync(join(directory, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    return entry.isDirectory() ? listFiles(directory, relativePath) : [relativePath];
  });
}

describe('runtime image source', () => {
  it('copies the pruned source artifact instead of the raw source tree', () => {
    const dockerfile = readFileSync(join(repositoryRoot, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('RUN ./scripts/prepare-runtime-src.sh ./src /runtime-src');
    expect(dockerfile).toContain('COPY --chown=bun:bun --from=builder /runtime-src ./src');
    expect(dockerfile).not.toContain('COPY --chown=bun:bun --from=builder /app/src ./src');
  });

  it('removes test files and test-only helpers while retaining production source', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'runtime-src-'));
    const source = join(fixtureRoot, 'src');
    const destination = join(fixtureRoot, 'output');

    try {
      mkdirSync(join(source, 'lib', 'testing'), { recursive: true });
      mkdirSync(join(source, 'lib', 'test-support'), { recursive: true });
      mkdirSync(join(source, 'lib', 'pharmacy', 'migration', 'fixtures'), { recursive: true });
      mkdirSync(join(source, 'feature', 'mocks'), { recursive: true });
      mkdirSync(join(source, 'feature', '__snapshots__'), { recursive: true });
      mkdirSync(join(source, 'app', 'api', 'trpc'), { recursive: true });
      writeFileSync(join(source, 'feature.ts'), 'export const feature = true;');
      writeFileSync(join(source, 'feature.test.ts'), 'test-only');
      writeFileSync(join(source, 'feature', 'view.test.tsx'), 'test-only');
      writeFileSync(join(source, 'feature', 'worker.spec.mts'), 'test-only');
      writeFileSync(join(source, 'feature', 'mailer.mock.ts'), 'test-only');
      writeFileSync(join(source, 'feature', 'mocks', 'clock.ts'), 'test-only');
      writeFileSync(
        join(source, 'app', 'api', 'trpc', 'transaction-boundary.real-http.runner.py'),
        'test-only',
      );
      writeFileSync(join(source, 'feature', '__snapshots__', 'view.test.tsx.snap'), 'test-only');
      writeFileSync(join(source, 'lib', 'testing', 'fixture.ts'), 'test-only');
      writeFileSync(join(source, 'lib', 'test-support', 'departments.ts'), 'test-only');
      writeFileSync(
        join(source, 'lib', 'pharmacy', 'repeat-purchasing.fixture.sql'),
        'test-only',
      );
      writeFileSync(
        join(source, 'lib', 'pharmacy', 'migration', 'fixtures', 'stock-export.csv'),
        'test-only',
      );

      execFileSync(join(repositoryRoot, 'scripts', 'prepare-runtime-src.sh'), [source, destination]);

      expect(readFileSync(join(destination, 'feature.ts'), 'utf8')).toBe(
        'export const feature = true;',
      );
      expect(() => readFileSync(join(destination, 'feature.test.ts'))).toThrow();
      expect(() => readFileSync(join(destination, 'feature', 'view.test.tsx'))).toThrow();
      expect(() => readFileSync(join(destination, 'feature', 'worker.spec.mts'))).toThrow();
      expect(() => readFileSync(join(destination, 'feature', 'mailer.mock.ts'))).toThrow();
      expect(() => readFileSync(join(destination, 'feature', 'mocks', 'clock.ts'))).toThrow();
      expect(() =>
        readFileSync(
          join(destination, 'app', 'api', 'trpc', 'transaction-boundary.real-http.runner.py'),
        ),
      ).toThrow();
      expect(() =>
        readFileSync(join(destination, 'feature', '__snapshots__', 'view.test.tsx.snap')),
      ).toThrow();
      expect(() => readFileSync(join(destination, 'lib', 'testing', 'fixture.ts'))).toThrow();
      expect(() =>
        readFileSync(join(destination, 'lib', 'test-support', 'departments.ts')),
      ).toThrow();
      expect(() =>
        readFileSync(join(destination, 'lib', 'pharmacy', 'repeat-purchasing.fixture.sql')),
      ).toThrow();
      expect(() =>
        readFileSync(
          join(destination, 'lib', 'pharmacy', 'migration', 'fixtures', 'stock-export.csv'),
        ),
      ).toThrow();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not leave test support files in the prepared repository source', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'runtime-src-repository-'));
    const destination = join(fixtureRoot, 'output');

    try {
      execFileSync(join(repositoryRoot, 'scripts', 'prepare-runtime-src.sh'), [
        join(repositoryRoot, 'src'),
        destination,
      ]);

      const artifactFiles = listFiles(destination);

      expect(
        artifactFiles.filter((file) =>
          /(^|\/)(?:testing|test-support|__tests__|__snapshots__|fixtures?|mocks?)(\/|\.|$)|\.(?:test|spec)\./i.test(
            file,
          ),
        ),
      ).toEqual([]);
      expect(artifactFiles).not.toContain(
        'app/api/trpc/transaction-boundary.real-http.runner.py',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
