import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertCiMemory, checkCiMemory } from '../scripts/check-ci-memory.mjs';

const GiB = 1024 ** 3;

function workflow(name: string) {
  return readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8');
}

describe('QA runner memory preflight', () => {
  it('rejects the reviewed 6 GiB Docker VM even on a larger host', () => {
    expect(() => assertCiMemory(32 * GiB, 6 * GiB, ['max'])).toThrow(
      'effective runner/Docker memory is 6144 MiB'
    );
  });

  it('respects the runner container cap on cgroup v2', () => {
    expect(() => assertCiMemory(32 * GiB, 16 * GiB, [String(6 * GiB)])).toThrow(
      'effective runner/Docker memory is 6144 MiB'
    );
  });

  it('respects the runner container cap on cgroup v1', () => {
    expect(() => assertCiMemory(32 * GiB, 16 * GiB, ['max', String(8 * GiB)])).toThrow(
      'effective runner/Docker memory is 8192 MiB'
    );
  });

  it('accepts sufficient memory with an unlimited cgroup', () => {
    expect(() => assertCiMemory(16 * GiB, 16 * GiB, ['max', '9223372036854771712'])).not.toThrow();
  });

  it('requires headroom above the V8 heap allowance', () => {
    expect(() => assertCiMemory(8 * GiB, 16 * GiB, [])).toThrow('at least 12288 MiB');
  });

  it('fails closed when no memory value can be read', () => {
    expect(() => assertCiMemory(Number.NaN, Number.NaN, ['max', ''])).toThrow(
      'Cannot determine effective runner/Docker memory'
    );
    expect(() =>
      checkCiMemory(Number.NaN, Number.NaN, [], { enforce: true, log: () => {} })
    ).toThrow('Cannot determine');
  });

  it('only warns on a standard 7 GB hosted runner unless enforcement is enabled', () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(checkCiMemory(7 * GiB, 7 * GiB, ['max'], { log })).toBe(false);
    expect(lines).toEqual([expect.stringMatching(/^::warning .*effective runner\/Docker memory is 7168 MiB/)]);
    expect(() => checkCiMemory(7 * GiB, 7 * GiB, ['max'], { enforce: true, log })).toThrow(
      'at least 12288 MiB'
    );
    expect(checkCiMemory(16 * GiB, 16 * GiB, ['max'], { log })).toBe(true);
  });
});

describe('PR runner safety', () => {
  it.each([
    ['qa.yml', 2],
    ['image-build.yml', 1],
  ] as const)('keeps every job in %s on a disposable hosted VM', (name, jobCount) => {
    const source = workflow(name);
    const runners = [...source.matchAll(/^    runs-on: (.+)$/gm)].map((match) => match[1]);
    expect(runners).toEqual(Array(jobCount).fill('ubuntu-latest'));
    expect(source).not.toContain('self-hosted,');
  });

  it('retains the QA memory checks without persistent-host tool installers', () => {
    const source = workflow('qa.yml');
    expect(source.match(/run: node scripts\/check-ci-memory\.mjs/g)).toHaveLength(2);
    expect(source).not.toContain('InstallAzureCLIDeb');
    expect(source).not.toContain('sudo bash');
    expect(source).not.toContain('command -v psql');
    expect(source).not.toContain('command -v az');
    expect(source).not.toContain('az bicep install');
    expect(source.match(/uses: actions\/setup-node@[a-f0-9]{40} /g)).toHaveLength(2);
    expect(source.match(/uses: actions\/setup-node@/g)).toHaveLength(2);
    expect(source.match(/node-version: 22\.20\.0$/gm)).toHaveLength(2);
    expect(source).not.toContain('CI_MEMORY_ENFORCE');
  });

  it('rejects a non-native runner before building the amd64 image', () => {
    const source = workflow('image-build.yml');
    const guard = source.indexOf('if [ "$RUNNER_ARCH" != "X64" ]; then');
    const build = source.indexOf('run: docker build --progress=plain .');
    expect(guard).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(guard);
    expect(source.slice(guard, build)).toContain('exit 1');
  });
});
