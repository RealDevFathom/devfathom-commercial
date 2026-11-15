// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * DEV-755: DevFathom no longer uses Azure. Dependencies, workflows, infrastructure,
 * configuration and product code must not name it. Applied migrations are history
 * and stay as written; tests may still name the removed selectors to prove they are
 * refused.
 */
const ROOT = process.cwd();
const AZURE = /azure/i;

function filesUnder(path: string): string[] {
  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [path];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(join(path, entry.name))
  );
}

const isTest = (path: string) => /\.test\.[cm]?[jt]sx?$/.test(path) || path.endsWith('.test.mjs');

function offenders(paths: string[]): string[] {
  return paths.filter((path) => AZURE.test(readFileSync(join(ROOT, path), 'utf8')));
}

describe('no Azure', () => {
  it('declares no Azure package, override or script', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'overrides',
      'resolutions',
    ]) {
      const names = Object.keys((manifest[section] as Record<string, unknown>) ?? {});
      expect(
        names.filter((name) => AZURE.test(name)),
        section
      ).toEqual([]);
    }
    expect(offenders(['package.json'])).toEqual([]);
  });

  it('keeps Azure out of workflows, infrastructure and environment configuration', () => {
    const paths = [
      ...filesUnder('.github'),
      ...filesUnder('infra').filter((path) => !path.endsWith('.pem')),
      ...filesUnder('docker'),
      ...readdirSync(ROOT).filter((name) => /^(?:Dockerfile.*|\.env\.example)$/.test(name)),
    ];
    expect(paths.length).toBeGreaterThan(0);
    expect(offenders(paths)).toEqual([]);
  });

  it('keeps Azure out of product code, scripts and database preparation', () => {
    const paths = [
      ...filesUnder('src').filter((path) => !path.startsWith(join('src', 'generated'))),
      ...filesUnder('scripts'),
      ...filesUnder('prisma').filter((path) => !path.startsWith(join('prisma', 'migrations'))),
    ]
      .filter((path) => /\.(?:[cm]?[jt]sx?|sql|prisma|css|json)$/.test(path))
      .filter((path) => !isTest(path))
      .map((path) => relative(ROOT, join(ROOT, path)));
    expect(paths.length).toBeGreaterThan(0);
    expect(offenders(paths)).toEqual([]);
  });
});
