import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('container build contract', () => {
  it('keeps the direct Docker build equivalent to the package build script', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');

    // Docker deliberately bypasses the package-manager script so Next runs on
    // real Node. If the script gains a step, this assertion forces the image
    // build sequence and this contract to be reviewed together.
    expect(packageJson.scripts?.build).toBe('prisma generate && next build');
    expect(dockerfile).toContain('node node_modules/prisma/build/index.js generate');
    expect(dockerfile).toContain(
      'AUTH_SECRET=container-build-only node node_modules/next/dist/bin/next build',
    );
  });
});
