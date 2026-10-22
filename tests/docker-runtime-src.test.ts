import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('production runtime source preparation', () => {
  it('keeps application source while removing tests and test-only helpers', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-src-'));
    temporaryDirectories.push(root);

    const source = join(root, 'src');
    const runtime = join(root, 'runtime-src');
    mkdirSync(join(source, 'app'), { recursive: true });
    mkdirSync(join(source, 'lib', 'testing'), { recursive: true });
    writeFileSync(join(source, 'app', 'page.ts'), 'export default function Page() {}');
    writeFileSync(join(source, 'app', 'page.test.ts'), 'test("page", () => {});');
    writeFileSync(join(source, 'app', 'view.test.tsx'), 'test("view", () => {});');
    writeFileSync(join(source, 'app', 'runtime.test.mts'), 'test("runtime", () => {});');
    writeFileSync(join(source, 'app', 'fixture.test.mjs'), 'test("fixture", () => {});');
    writeFileSync(join(source, 'app', 'page.test.ts.snap'), 'snapshot');
    writeFileSync(join(source, 'lib', 'testing', 'fixture.ts'), 'export const fixture = {};');

    execFileSync(resolve('docker/prepare-runtime-src.sh'), [source, runtime]);

    expect(readFileSync(join(runtime, 'app', 'page.ts'), 'utf8')).toContain('Page');
    expect(() => readFileSync(join(runtime, 'app', 'page.test.ts'))).toThrow();
    expect(() => readFileSync(join(runtime, 'app', 'view.test.tsx'))).toThrow();
    expect(() => readFileSync(join(runtime, 'app', 'runtime.test.mts'))).toThrow();
    expect(() => readFileSync(join(runtime, 'app', 'fixture.test.mjs'))).toThrow();
    expect(() => readFileSync(join(runtime, 'app', 'page.test.ts.snap'))).toThrow();
    expect(() => readFileSync(join(runtime, 'lib', 'testing', 'fixture.ts'))).toThrow();
  });
});
