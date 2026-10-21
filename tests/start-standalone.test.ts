// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';

it('ships public and static assets before running the standalone server', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-start-test-'));
  try {
    for (const dir of ['public/licenses', '.next/static', '.next/standalone']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, 'public/licenses/font.txt'), 'font license');
    writeFileSync(join(root, '.next/static/chunk.js'), 'application chunk');
    writeFileSync(
      join(root, '.next/standalone/server.js'),
      `
      const fs = require('node:fs');
      const path = require('node:path');
      console.log(fs.readFileSync(path.join(__dirname, 'public/licenses/font.txt'), 'utf8'));
      console.log(fs.readFileSync(path.join(__dirname, '.next/static/chunk.js'), 'utf8'));
    `
    );
    expect(
      execFileSync(process.execPath, [resolve('scripts/start-standalone.mjs')], {
        cwd: root,
        encoding: 'utf8',
      })
    ).toBe('font license\napplication chunk\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
