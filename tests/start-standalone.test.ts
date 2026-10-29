// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

it('uses packaged assets without copying missing source directories or overwriting uploads', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-staged-test-'));
  try {
    mkdirSync(join(root, '.next/standalone/private-uploads'), { recursive: true });
    mkdirSync(join(root, '.next/standalone/.next/static'), { recursive: true });
    writeFileSync(join(root, '.next/standalone/.assets-staged'), '');
    writeFileSync(
      join(root, '.next/standalone/private-uploads/persistent.txt'),
      'persistent upload'
    );
    writeFileSync(join(root, '.next/standalone/.next/static/chunk.js'), 'staged chunk');
    writeFileSync(
      join(root, '.next/standalone/server.js'),
      `
      const fs = require('node:fs');
      console.log(fs.readFileSync(__dirname + '/private-uploads/persistent.txt', 'utf8'));
      console.log(fs.readFileSync(__dirname + '/.next/static/chunk.js', 'utf8'));
    `
    );
    expect(
      execFileSync(process.execPath, [resolve('scripts/start-standalone.mjs')], {
        cwd: root,
        encoding: 'utf8',
      })
    ).toBe('persistent upload\nstaged chunk\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('unstaged startup excludes private upload directories and public symlink aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-private-start-test-'));
  try {
    for (const path of [
      'public/uploads',
      'public/private-uploads',
      'public/nested/uploads',
      'private-uploads',
      '.next/static',
      '.next/standalone/public/uploads',
    ])
      mkdirSync(join(root, path), { recursive: true });
    for (const path of [
      'public/uploads/old.txt',
      'public/private-uploads/secret.txt',
      'public/nested/uploads/secret.txt',
      'private-uploads/persistent.txt',
      '.next/standalone/public/uploads/stale.txt',
    ])
      writeFileSync(join(root, path), 'private');
    symlinkSync(join(root, 'private-uploads'), join(root, 'public/innocent-alias'));
    writeFileSync(join(root, 'public/license.txt'), 'license');
    writeFileSync(join(root, '.next/static/chunk.js'), 'chunk');
    writeFileSync(
      join(root, '.next/standalone/server.js'),
      `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      for (const path of ['uploads', 'private-uploads', 'nested/uploads', 'innocent-alias'])
        assert.equal(fs.existsSync(__dirname + '/public/' + path), false);
      assert.equal(fs.readFileSync(__dirname + '/public/license.txt', 'utf8'), 'license');
      assert.equal(fs.readFileSync(__dirname + '/.next/static/chunk.js', 'utf8'), 'chunk');
      assert.equal(fs.readFileSync(process.cwd() + '/private-uploads/persistent.txt', 'utf8'), 'private');
      console.log('private uploads excluded');
    `
    );
    expect(
      execFileSync(process.execPath, [resolve('scripts/start-standalone.mjs')], {
        cwd: root,
        encoding: 'utf8',
      })
    ).toBe('private uploads excluded\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
