// @vitest-environment node
// Reconstructed DEV-94 regressions: intentionally unexecuted in the recovery lane.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Call = { command: string; args: string[]; database: string };
const archiveName = 'postgres-20261102T020000Z-123.dump';
const sourceUri = `s3://backup-bucket/pharmacy/${archiveName}`;
const target = 'devfathom_restore_20261102';
const kmsArn = 'arn:aws:kms:us-east-1:123456789012:key/test-key';
let root: string;
let env: NodeJS.ProcessEnv;

// All AWS and PostgreSQL commands are local fakes; no credentials or network are needed.
const fakeCommand = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({
  command, args, database: process.env.PGDATABASE
}) + '\n');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
if (command === 'pg_dump') {
  fs.writeFileSync(args[args.indexOf('--file') + 1], 'fake custom archive');
} else if (command === 'sha256sum') {
  if (args.includes('--check')) {
    const line = fs.readFileSync(args.at(-1), 'utf8').trimEnd();
    const [expected, filename] = line.split('  ');
    process.exit(hash(fs.readFileSync(filename)) === expected ? 0 : 1);
  }
  console.log(hash(fs.readFileSync(args[0])) + '  ' + args[0]);
} else if (command === 'aws' && args[0] === 's3') {
  if (process.env.UPLOAD_FAIL === '1') process.exit(1);
  fs.copyFileSync(args[2], path.join(root, path.basename(args[3])));
} else if (command === 'aws' && args[0] === 's3api') {
  const keyIndex = args.indexOf('--key');
  const key = args[keyIndex + 1];
  const output = args[keyIndex + 2];
  const sidecar = key.endsWith('.sha256');
  const bytes = Buffer.from('fake custom archive');
  const digest = process.env.BAD_CHECKSUM === '1' ? '0'.repeat(64) : hash(bytes);
  const name = process.env.BAD_BASENAME === '1' ? '../other.dump' : path.basename(key).slice(0, -7);
  fs.writeFileSync(output, sidecar ? digest + '  ' + name + '\n' : bytes);
  const encryption = (sidecar && process.env.SIDECAR_ENCRYPTION) || process.env.ENCRYPTION || 'AES256';
  console.log(encryption + '\t' + (process.env.OBJECT_KMS_KEY || 'None'));
} else if (command === 'psql') {
  const query = args.find((arg) => arg.startsWith('--command='));
  if (query.includes('current_database()')) {
    console.log(process.env.ACTUAL_SOURCE || process.env.PGDATABASE);
  } else {
    if (process.env.MISSING_MIGRATIONS === '1') process.exit(1);
    console.log(process.env.MIGRATION_COUNT || '7');
  }
} else if (command === 'createdb') {
  if (process.env.TARGET_EXISTS === '1') process.exit(1);
  fs.writeFileSync(path.join(root, 'created'), args.at(-1));
} else if (command === 'pg_restore') {
  if (args.includes('--list')) process.exit(process.env.BAD_ARCHIVE === '1' ? 1 : 0);
  const created = fs.readFileSync(path.join(root, 'created'), 'utf8');
  if (!args.includes('--dbname=' + created)) process.exit(1);
  if (process.env.RESTORE_FAIL === '1') process.exit(1);
} else {
  process.exit(99);
}
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'postgres-backup-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const command of ['aws', 'pg_dump', 'pg_restore', 'psql', 'createdb', 'dropdb', 'sha256sum']) {
    writeFileSync(join(bin, command), `#!${process.execPath}\n${fakeCommand}`, { mode: 0o700 });
  }
  writeFileSync(join(root, 'calls'), '');
  writeFileSync(join(root, 'pgpass'), '*:*:*:backup:fixture-secret', { mode: 0o600 });
  env = {
    PATH: `${bin}:/usr/bin:/bin`,
    FIXTURE_ROOT: root,
    TMPDIR: root,
    PGHOST: 'database.invalid',
    PGPORT: '5432',
    PGUSER: 'backup',
    PGDATABASE: 'pharmacy',
    PGPASSFILE: join(root, 'pgpass'),
    BACKUP_S3_URI: 's3://backup-bucket/pharmacy',
    ALLOW_DISPOSABLE_RESTORE: '1',
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script: 'backup' | 'restore', args: string[] = []) {
  return spawnSync('bash', [resolve(`scripts/backup/${script}-postgres.sh`), ...args], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function calls() {
  return readFileSync(join(root, 'calls'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
}

function expectNoCreation() {
  expect(calls().some((call) => call.command === 'createdb')).toBe(false);
  expect(calls().some((call) => call.args.some((arg) => arg.startsWith('--dbname=')))).toBe(false);
}

describe('PostgreSQL backup', () => {
  it.each(['AES256', 'aws:kms'])('validates, hashes and explicitly encrypts both uploads: %s', (sse) => {
    if (sse === 'aws:kms') env.BACKUP_KMS_KEY_ID = kmsArn;
    const result = run('backup');
    expect(result.status, result.stderr).toBe(0);
    const log = calls();
    expect(log[0].args).toEqual([
      '--no-password',
      '--format=custom',
      '--compress=6',
      '--file',
      expect.stringMatching(/\.dump$/),
    ]);
    expect(log[1].args[0]).toBe('--list');
    const uploads = log.filter((call) => call.command === 'aws');
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.args.slice(4, 6)).toEqual(['--sse', sse]);
      if (sse === 'aws:kms') expect(upload.args.slice(6, 8)).toEqual(['--sse-kms-key-id', kmsArn]);
    }
    const filename = uploads[0].args[3].split('/').at(-1)!;
    const digest = createHash('sha256').update(readFileSync(join(root, filename))).digest('hex');
    expect(readFileSync(join(root, `${filename}.sha256`), 'utf8')).toBe(`${digest}  ${filename}\n`);
    expect(JSON.stringify(log)).not.toContain('fixture-secret');
  });

  it('does not upload an unreadable archive', () => {
    env.BAD_ARCHIVE = '1';
    expect(run('backup').status).not.toBe(0);
    expect(calls().some((call) => call.command === 'aws')).toBe(false);
  });

  it('does not publish a completion sidecar after a failed dump upload', () => {
    env.UPLOAD_FAIL = '1';
    expect(run('backup').status).not.toBe(0);
    expect(calls().filter((call) => call.command === 'aws')).toHaveLength(1);
  });
});

describe('disposable PostgreSQL restore', () => {
  it.each(['AES256', 'aws:kms'])('verifies downloaded bytes before creating target: %s', (sse) => {
    env.ENCRYPTION = sse;
    if (sse === 'aws:kms') {
      env.BACKUP_KMS_KEY_ID = kmsArn;
      env.OBJECT_KMS_KEY = kmsArn;
    }
    const result = run('restore', [sourceUri, target]);
    expect(result.status, result.stderr).toBe(0);
    const log = calls();
    expect(log.map((call) => call.command)).toEqual([
      'psql',
      'aws',
      'aws',
      'sha256sum',
      'pg_restore',
      'createdb',
      'pg_restore',
      'psql',
    ]);
    expect(log[4].args[0]).toBe('--list');
    expect(log[5].args).toEqual([
      '--no-password',
      '--maintenance-db=pharmacy',
      '--template=template0',
      '--',
      target,
    ]);
    expect(log[6].args).toEqual(
      expect.arrayContaining([
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        `--dbname=${target}`,
      ])
    );
    expect(log[6].args).not.toContain('--clean');
    expect(log[6].args).not.toContain('--create');
    expect(log[6].database).toBe(target);
    expect(log[7].database).toBe(target);
    expect(log[7].args).toContain('--set=ON_ERROR_STOP=1');
    const query = log[7].args.join(' ');
    expect(query).toContain('public."_prisma_migrations"');
    expect(query).toContain('finished_at IS NOT NULL AND rolled_back_at IS NULL');
    expect(query).toContain('finished_at IS NULL AND rolled_back_at IS NULL');
    expect(result.stdout).toContain('successful Prisma migrations: 7');
    expect(JSON.stringify(log)).not.toContain('fixture-secret');
    expect(log.some((call) => call.command === 'dropdb')).toBe(false);
  });

  it.each([
    ['BAD_CHECKSUM', '1'],
    ['BAD_BASENAME', '1'],
    ['BAD_ARCHIVE', '1'],
    ['ENCRYPTION', 'None'],
    ['ENCRYPTION', 'aws:kms'],
    ['SIDECAR_ENCRYPTION', 'None'],
    ['BACKUP_KMS_KEY_ID', kmsArn],
    ['ACTUAL_SOURCE', target],
    ['ALLOW_DISPOSABLE_RESTORE', ''],
    ['PGDATABASE', 'dbname=pharmacy password=secret'],
  ])('fails before database creation when %s=%s', (key, value) => {
    env[key] = value;
    expect(run('restore', [sourceUri, target]).status).not.toBe(0);
    expectNoCreation();
  });

  it('refuses a different KMS key', () => {
    env.ENCRYPTION = 'aws:kms';
    env.OBJECT_KMS_KEY = `${kmsArn}-other`;
    env.BACKUP_KMS_KEY_ID = kmsArn;
    expect(run('restore', [sourceUri, target]).status).not.toBe(0);
    expectNoCreation();
  });

  it.each([
    'pharmacy',
    'postgres',
    'devfathom_restore_x dbname=pharmacy',
    `devfathom_restore_${'x'.repeat(47)}`,
  ])('rejects unsafe target %s', (name) => {
    expect(run('restore', [sourceUri, name]).status).not.toBe(0);
    expectNoCreation();
  });

  it('refuses the source even when its name has the disposable prefix', () => {
    env.PGDATABASE = target;
    expect(run('restore', [sourceUri, target]).status).not.toBe(0);
    expectNoCreation();
  });

  it('does not restore or drop anything when atomic target creation fails', () => {
    env.TARGET_EXISTS = '1';
    expect(run('restore', [sourceUri, target]).status).not.toBe(0);
    expect(calls().at(-1)?.command).toBe('createdb');
    expect(calls().filter((call) => call.command === 'pg_restore')).toHaveLength(1);
    expect(calls().some((call) => call.command === 'dropdb')).toBe(false);
  });

  it.each(['MISSING_MIGRATIONS', 'RESTORE_FAIL', 'MIGRATION_COUNT'])(
    'reports failure without dropping target when %s fails',
    (key) => {
      env[key] = key === 'MIGRATION_COUNT' ? '0' : '1';
      const result = run('restore', [sourceUri, target]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('Restore drill complete');
      expect(calls().some((call) => call.command === 'dropdb')).toBe(false);
    }
  );
});
