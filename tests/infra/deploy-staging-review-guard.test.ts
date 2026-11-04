// @vitest-environment node
// DEV-341: the full staging deployment must refuse to reach Azure until an authorized operator has
// reviewed the current what-if. These tests run the real scripts against a fake `az` executable in
// a temporary copy of the bound infrastructure files; nothing here can reach a real Azure CLI.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const BOUND_FILES = [
  'infra/deploy-staging.sh',
  'infra/staging-review-guard.sh',
  'infra/shared.bicep',
  'infra/environment.bicep',
  'infra/acr-pull.bicep',
  'infra/staging.bicepparam',
];
const SCRIPTS = [...BOUND_FILES, 'infra/record-staging-review.sh'];

const FAKE_AZ = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_AZ_LOG"
case "$*" in
  "keyvault list"*) exit 0 ;;
  *"--query properties.outputs.registryName.value"*) echo fakeregistry ;;
  *"--query properties.outputs.appName.value"*) echo fake-app ;;
  *"--query properties.outputs.appFqdn.value"*) echo fake.example.invalid ;;
  *"--query properties.outputs.migrationJobName.value"*) echo fake-job ;;
esac
exit 0
`;

let root: string;
let bin: string;
let azLog: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: root,
    FAKE_AZ_LOG: azLog,
    DEVFATHOM_STAGING_IMAGE: 'fakeregistry.azurecr.io/devfathom-commercial@sha256:' + '0'.repeat(64),
  };
  return { ...base, ...extra };
}

function run(script: string, args: string[] = [], extra: Record<string, string> = {}, cwd = root) {
  return spawnSync('bash', [script, ...args], { cwd, env: env(extra), encoding: 'utf8' });
}

function azCalls(): string[] {
  return existsSync(azLog) ? readFileSync(azLog, 'utf8').split('\n').filter(Boolean) : [];
}

function writeWhatIf(content = '{"status":"Succeeded","changes":[]}\n') {
  writeFileSync(join(root, 'whatif-staging.json'), content);
}

function record(extra: Record<string, string> = {}) {
  return run(
    'infra/record-staging-review.sh',
    ['--reviewer', 'Staging Operator', '--confirm-every-modify-and-delete-reviewed'],
    extra
  );
}

function approvalPath() {
  return join(root, '.staging-review', 'approval');
}

function readApproval(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(approvalPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
}

function writeApproval(fields: Record<string, string>) {
  mkdirSync(join(root, '.staging-review'), { recursive: true });
  writeFileSync(
    approvalPath(),
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
  );
}

function utc(offsetSeconds: number) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function expectRefusedWithoutAzure(result: ReturnType<typeof run>, message: RegExp) {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('DEV-341 staging review gate');
  expect(result.stderr).toMatch(message);
  expect(azCalls()).toEqual([]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dev341-'));
  bin = join(root, '.fake-bin');
  azLog = join(root, '.fake-az.log');
  mkdirSync(join(root, 'infra'));
  mkdirSync(bin);
  for (const file of SCRIPTS) copyFileSync(join(REPO, file), join(root, file));
  writeFileSync(join(bin, 'az'), FAKE_AZ);
  chmodSync(join(bin, 'az'), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('DEV-341 staging deployment review gate', () => {
  it('sources the guard before the first Azure command in deploy-staging.sh', () => {
    const script = readFileSync(join(REPO, 'infra/deploy-staging.sh'), 'utf8');
    const guard = script.indexOf('\nstaging_review_require_approval\n');
    const firstAz = script.search(/^\s*(?:[\w]+=\$\()?az\s/m);
    expect(guard).toBeGreaterThan(0);
    expect(firstAz).toBeGreaterThan(guard);
    expect(readFileSync(join(REPO, 'infra/staging-review-guard.sh'), 'utf8')).not.toMatch(
      /^\s*az\s/m
    );
  });

  it('refuses without any approval and never calls Azure', () => {
    writeWhatIf();
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /no review approval/);
  });

  it('ignores would-be bypass environment variables', () => {
    writeWhatIf();
    const result = run('infra/deploy-staging.sh', [], {
      DEVFATHOM_SKIP_STAGING_REVIEW: 'true',
      DEVFATHOM_STAGING_REVIEW_APPROVED: 'true',
      STAGING_REVIEW_MAX_AGE_SECONDS: '999999999',
      CI: 'true',
    });
    expectRefusedWithoutAzure(result, /no review approval/);
  });

  it('refuses a malformed approval', () => {
    writeWhatIf();
    mkdirSync(join(root, '.staging-review'));
    writeFileSync(approvalPath(), 'approved\n');
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /malformed/);
  });

  it('refuses an empty approval', () => {
    writeWhatIf();
    mkdirSync(join(root, '.staging-review'));
    writeFileSync(approvalPath(), '');
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /version/);
  });

  it('refuses an approval that is a symlink', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    const real = join(root, 'elsewhere');
    copyFileSync(approvalPath(), real);
    rmSync(approvalPath());
    symlinkSync(real, approvalPath());
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /regular file/);
  });

  it('does not execute approval content as shell', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    const marker = join(root, 'pwned');
    writeFileSync(approvalPath(), readFileSync(approvalPath(), 'utf8') + `x=$(touch ${marker})\n`);
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /unknown key/);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['version', '2', /version/],
    ['decision', 'looks-fine', /Modify and Delete/],
    ['iac_sha256', 'not-a-digest', /digests are missing or malformed/],
    ['whatif_sha256', 'A'.repeat(64), /digests are missing or malformed/],
    ['reviewer', '', /reviewer/],
    ['reviewed_at', 'yesterday', /UTC timestamp/],
    ['reviewed_at', '2026-13-45T99:99:99Z', /valid date/],
  ])('refuses an approval with bad %s', (key, value, message) => {
    writeWhatIf();
    expect(record().status).toBe(0);
    writeApproval({ ...readApproval(), [key]: value });
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), message);
  });

  it('refuses an approval missing a required key', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    const approval = readApproval();
    delete approval.reviewer;
    writeApproval(approval);
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /reviewer/);
  });

  it('refuses an approval with a repeated key', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    writeFileSync(
      approvalPath(),
      readFileSync(approvalPath(), 'utf8') + `iac_sha256=${'0'.repeat(64)}\n`
    );
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /repeats a key/);
  });

  it('refuses a stale approval', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    writeApproval({ ...readApproval(), reviewed_at: utc(-(24 * 60 * 60 + 60)) });
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /stale/);
  });

  it('refuses a future-dated approval', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    writeApproval({ ...readApproval(), reviewed_at: utc(60 * 60) });
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /future/);
  });

  it.each(BOUND_FILES)('invalidates the approval when %s changes', (file) => {
    writeWhatIf();
    expect(record().status).toBe(0);
    const comment = file.endsWith('.sh') ? '# changed' : '// changed';
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8') + `\n${comment}\n`);
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /infrastructure files changed/);
  });

  it('refuses when the reviewed what-if output is missing or replaced', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    writeWhatIf('{"status":"Succeeded","changes":[{"changeType":"Delete"}]}\n');
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /not the one that was reviewed/);
    rmSync(join(root, 'whatif-staging.json'));
    expectRefusedWithoutAzure(run('infra/deploy-staging.sh'), /missing or empty/);
  });

  it('refuses when run from outside the repository root', () => {
    writeWhatIf();
    expect(record().status).toBe(0);
    const result = run(join(root, 'infra/deploy-staging.sh'), [], {}, join(root, 'infra'));
    expectRefusedWithoutAzure(result, /repository root/);
  });

  it('will not record a review without explicit confirmation or a what-if', () => {
    const missingWhatIf = record();
    expect(missingWhatIf.status).not.toBe(0);
    expect(existsSync(approvalPath())).toBe(false);

    writeWhatIf();
    const unconfirmed = run('infra/record-staging-review.sh', ['--reviewer', 'Staging Operator']);
    expect(unconfirmed.status).not.toBe(0);
    const anonymous = run('infra/record-staging-review.sh', [
      '--confirm-every-modify-and-delete-reviewed',
    ]);
    expect(anonymous.status).not.toBe(0);
    expect(existsSync(approvalPath())).toBe(false);
    expect(azCalls()).toEqual([]);
  });

  it('runs the existing deployment flow after a genuine, current approval', () => {
    writeWhatIf();
    const recorded = record();
    expect(recorded.status).toBe(0);
    expect(azCalls()).toEqual([]);

    const approval = readApproval();
    expect(Object.keys(approval).sort()).toEqual(
      ['decision', 'iac_sha256', 'reviewed_at', 'reviewer', 'version', 'whatif_sha256'].sort()
    );
    expect(approval.reviewer).toBe('Staging Operator');

    const result = run('infra/deploy-staging.sh');
    expect(result.stderr).toContain('approval by Staging Operator');
    expect(result.status).toBe(0);

    const calls = azCalls();
    expect(calls[0]).toBe(
      'group create --name rg-devfathom-shared-uaenorth --location uaenorth --output none'
    );
    expect(calls).toContain(
      'deployment group create --resource-group rg-devfathom-staging-uaenorth --parameters infra/staging.bicepparam --name staging --output none'
    );
    expect(calls.at(-1)).toBe(
      'containerapp job start --resource-group rg-devfathom-staging-uaenorth --name fake-job --output none'
    );
  });
});
