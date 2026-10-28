// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const packageScript = resolve('scripts/deploy/package-develop.sh');
const activateScript = resolve('scripts/deploy/activate-develop.sh');
const sha = 'a'.repeat(40);
function put(root: string, path: string, content = '') {
  const file = join(root, path);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, content);
}
function fixture(root: string) {
  for (const [path, data] of Object.entries({
    '.next/standalone/server.js': '// server',
    '.next/standalone/node_modules/outer/node_modules/inner/index.js': 'nested dependency',
    '.next/standalone/.env.production': 'must not ship',
    '.next/static/chunk.js': 'chunk',
    'public/font.txt': 'font',
    'public/uploads/old.txt': 'must not ship',
    'node_modules/root-secret/index.js': 'must not ship',
    '.env.local': 'must not ship',
    'package.json': '{"dependencies":{"prisma":"7","dotenv":"17"}}',
    'bun.lock': 'lock',
    'prisma.config.ts': '// config',
    'prisma/schema.prisma': '// schema',
    'prisma/migrations/001/migration.sql': '-- migration',
    'scripts/start-standalone.mjs': readFileSync(resolve('scripts/start-standalone.mjs'), 'utf8'),
  }))
    put(root, path, data);
}
it('packages staged assets and nested traced dependencies, excluding checkout secrets and root dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'develop-package-'));
  try {
    fixture(root);
    // Standalone may omit its .next directory; packaging must create it.
    expect(existsSync(join(root, '.next/standalone/.next'))).toBe(false);
    const archive = join(root, 'release.tar.gz');
    execFileSync(packageScript, [root, archive]);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    expect(entries).toContain('./.next/standalone/node_modules/outer/node_modules/inner/index.js');
    expect(entries).toContain('./.next/standalone/.next/static/chunk.js');
    expect(entries).toContain('./.next/standalone/public/font.txt');
    expect(entries).toContain('./.next/standalone/.assets-staged');
    expect(entries).toContain('./prisma/migrations/001/migration.sql');
    expect(entries).not.toMatch(/\.env|root-secret|uploads|^\.\/node_modules\//m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of [
  'success',
  'restart-failure',
  'health-failure',
  'migration-failure',
  'replace-inactive',
  'replace-migration-failure',
  'replace-restart-failure',
  'same-sha',
  'same-sha-unhealthy',
]) {
  it(`activates safely with mocked AWS/systemctl: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'develop-activate-'));
    try {
      fixture(join(root, 'source'));
      execFileSync(packageScript, [join(root, 'source'), join(root, 'release.tar.gz')]);
      mkdirSync(join(root, 'releases/previous'), { recursive: true });
      mkdirSync(join(root, 'shared/uploads'), { recursive: true });
      put(root, 'shared/uploads/untouched', 'persistent');
      chmodSync(join(root, 'shared/uploads/untouched'), 0o600);
      const uploadBefore = statSync(join(root, 'shared/uploads/untouched'));
      // Use a real local supplementary group for chgrp, without OS account changes.
      const appGid =
        process.getgroups!().find((gid) => gid !== process.getgid!()) ?? process.getgid!();
      const repeat = mode.startsWith('same-sha');
      const replacing = mode.startsWith('replace-');
      if (repeat || replacing) {
        put(root, `releases/${sha}/original`, 'existing release');
      }
      for (let i = 0; i < 7; i++) mkdirSync(join(root, `releases/old-${i}`));
      symlinkSync(
        join(root, repeat ? `releases/${sha}` : 'releases/previous'),
        join(root, 'releases/current')
      );
      symlinkSync('/stale-after-sigkill', join(root, 'releases/.current-next'));
      symlinkSync(join(root, 'releases/current'), join(root, 'web'));
      put(root, 'develop.env', 'DATABASE_URL=postgresql://local:local@127.0.0.1:5432/local\n');
      const mocks: Record<string, string> = {
        chgrp: `args=("$@"); for i in "\${!args[@]}"; do if [[ "\${args[$i]}" == app ]]; then args[$i]=$TEST_APP_GID; fi; done; exec /usr/bin/chgrp "\${args[@]}"`,
        aws: 'echo download >> "$TEST_ROOT/downloads"; cp "$TEST_ROOT/release.tar.gz" "$4"',
        bun: `echo "$*" >> "$TEST_ROOT/bun-calls"
if [[ "$1" == install ]]; then
  mkdir -p node_modules/.bin node_modules/dotenv node_modules/restricted
  touch node_modules/.bin/prisma node_modules/restricted/data
  chmod +x node_modules/.bin/prisma
  chmod 700 node_modules/restricted
  chmod 600 node_modules/restricted/data
  ln -s "$TEST_ROOT/shared/uploads" node_modules/external
  exit
fi
[[ "$PWD" == "$TEST_ROOT/releases/.staging/"* ]]
[[ ! -e "$TEST_ROOT/releases/$TEST_SHA" || -f "$TEST_ROOT/releases/$TEST_SHA/original" ]]
[[ "$TEST_MODE" != *migration-failure ]]`,
        sudo: `echo "$*" >> "$TEST_ROOT/restarts"\nif [[ "$TEST_MODE" == *restart-failure && ! -f "$TEST_ROOT/failed" ]]; then touch "$TEST_ROOT/failed"; exit 1; fi`,
        curl: 'if [[ "$TEST_MODE" == health-failure || "$TEST_MODE" == same-sha-unhealthy ]]; then printf 503; else printf 200; fi',
        sleep: ':',
      };
      for (const [name, source] of Object.entries(mocks)) {
        put(root, `bin/${name}`, `#!/usr/bin/env bash\nset -eu\n${source}\n`);
        chmodSync(join(root, `bin/${name}`), 0o755);
      }
      const result = spawnSync('bash', [activateScript, 'test-bucket', sha, 'us-east-1'], {
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          DEVELOP_APP_ROOT: root,
          TEST_ROOT: root,
          TEST_MODE: mode,
          TEST_APP_GID: String(appGid),
          TEST_SHA: sha,
        },
        encoding: 'utf8',
      });
      const success = ['success', 'replace-inactive', 'same-sha'].includes(mode);
      expect(result.status, result.stderr).toBe(success ? 0 : 1);
      expect(() => lstatSync(join(root, 'releases/.current-next'))).toThrow();
      const uploadAfter = statSync(join(root, 'shared/uploads/untouched'));
      expect([uploadAfter.mode, uploadAfter.gid, uploadAfter.uid]).toEqual([
        uploadBefore.mode,
        uploadBefore.gid,
        uploadBefore.uid,
      ]);
      const current = readlinkSync(join(root, 'releases/current'));
      if (repeat) {
        expect(current).toBe(join(root, 'releases', sha));
        expect(readFileSync(join(current, 'original'), 'utf8')).toBe('existing release');
        for (const file of ['downloads', 'bun-calls', 'restarts'])
          expect(existsSync(join(root, file))).toBe(false);
        return;
      }
      if (success) {
        expect(current).toBe(join(root, 'releases', sha));
        expect(existsSync(join(current, 'original'))).toBe(false);
        expect(statSync(current).gid).toBe(appGid);
        expect(statSync(current).uid).toBe(process.getuid!());
        const restricted = statSync(join(current, 'node_modules/restricted'));
        const data = statSync(join(current, 'node_modules/restricted/data'));
        expect(restricted.mode & 0o750).toBe(0o750);
        expect(data.mode & 0o640).toBe(0o640);
        expect([restricted.gid, data.gid]).toEqual([appGid, appGid]);
        const cache = statSync(join(current, '.next/standalone/.next/cache'));
        expect(cache.gid).toBe(appGid);
        expect(cache.mode & 0o7777).toBe(0o2770);
        expect(statSync(current).mode & 0o7777).toBe(0o2750);
        expect(
          readdirSync(join(root, 'releases')).filter(
            (name) =>
              statSync(join(root, 'releases', name)).isDirectory() &&
              !['current', '.staging'].includes(name)
          )
        ).toHaveLength(5);
        expect(existsSync(join(root, 'releases/previous'))).toBe(true);
        if (mode === 'success') {
          put(current, '.next/standalone/.next/cache/runtime-data', 'keep cache');
          const inode = statSync(join(current, '.next/standalone/server.js')).ino;
          const retry = spawnSync('bash', [activateScript, 'test-bucket', sha, 'us-east-1'], {
            env: {
              ...process.env,
              PATH: `${root}/bin:${process.env.PATH}`,
              DEVELOP_APP_ROOT: root,
              TEST_ROOT: root,
              TEST_MODE: mode,
              TEST_APP_GID: String(appGid),
              TEST_SHA: sha,
            },
            encoding: 'utf8',
          });
          expect(retry.status, retry.stderr).toBe(0);
          expect(statSync(join(current, '.next/standalone/server.js')).ino).toBe(inode);
          expect(
            readFileSync(join(current, '.next/standalone/.next/cache/runtime-data'), 'utf8')
          ).toBe('keep cache');
          expect(readFileSync(join(root, 'downloads'), 'utf8').trim().split('\n')).toHaveLength(1);
          expect(readFileSync(join(root, 'bun-calls'), 'utf8').trim().split('\n')).toHaveLength(2);
        }
        for (const path of ['public/uploads', '.next/standalone/public/uploads']) {
          expect(readlinkSync(join(current, path))).toBe(join(root, 'shared/uploads'));
        }
      } else {
        expect(current).toBe(join(root, 'releases/previous'));
      }
      if (replacing && mode.endsWith('migration-failure'))
        expect(readFileSync(join(root, `releases/${sha}/original`), 'utf8')).toBe(
          'existing release'
        );
      expect(readdirSync(join(root, 'releases/.staging'))).toEqual([]);
      if (mode.endsWith('migration-failure'))
        expect(existsSync(join(root, 'restarts'))).toBe(false);
      else {
        const restarts = readFileSync(join(root, 'restarts'), 'utf8').trim().split('\n');
        expect(restarts).toHaveLength(success ? 1 : 2);
        expect(
          restarts.every((line) => line === '/usr/bin/systemctl restart devfathom-develop.service')
        ).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const workflow = readFileSync(resolve('.github/workflows/deploy-develop.yml'), 'utf8');
const gate = workflow
  .split('          script: |\n')[1]
  .split('\n      - name:')[0]
  .replace(/^            /gm, '');
for (const mode of [
  'success',
  'dispatch-qa',
  'wrong-workflow',
  'wrong-path',
  'wrong-sha',
  'stale-head',
  'skipped-job',
  'missing-job',
  'wrong-run',
  'wrong-repository',
]) {
  it(`gates exact push QA identity and jobs: ${mode}`, async () => {
    const run = {
      id: 1,
      workflow_id: mode === 'wrong-workflow' ? 2 : 10,
      path: mode === 'wrong-path' ? '.github/workflows/other.yml' : '.github/workflows/qa.yml',
      event: mode === 'dispatch-qa' ? 'workflow_dispatch' : 'push',
      head_sha: mode === 'wrong-sha' ? 'b'.repeat(40) : sha,
      head_branch: 'develop',
      head_repository: { full_name: mode === 'wrong-repository' ? 'fork/repo' : 'owner/repo' },
      conclusion: 'success',
    };
    const jobs = ['WHA-1125 automated gate', 'WHA-1132 browser gate'].map((name) => ({
      name,
      head_sha: sha,
      status: 'completed',
      conclusion: mode === 'skipped-job' ? 'skipped' : 'success',
    }));
    const listRuns = () => {};
    const listJobs = () => {};
    const github = {
      rest: {
        repos: {
          getBranch: async () => ({
            data: { commit: { sha: mode === 'stale-head' ? 'b'.repeat(40) : sha } },
          }),
        },
        actions: {
          getWorkflow: async () => ({ data: { id: 10 } }),
          listWorkflowRuns: listRuns,
          listJobsForWorkflowRun: listJobs,
        },
      },
      paginate: async (fn: unknown, args: Record<string, unknown>) => {
        if (fn === listRuns) {
          expect(args.workflow_id).toBe(10);
          expect(args.event).toBe('push');
          expect(args.head_sha).toBe(sha);
          return [run];
        }
        return mode === 'missing-job' ? jobs.slice(0, 1) : jobs;
      },
    };
    const result = runInNewContext(`(async () => {${gate}})()`, {
      github,
      process: { env: { DEPLOY_SHA: sha } },
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        eventName: 'workflow_run',
        payload: { workflow_run: { id: mode === 'wrong-run' ? 2 : 1 } },
      },
    });
    if (mode === 'success') await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow();
  });
}

for (const mode of ['Success', 'Failed', 'TimedOut', 'Cancelled', 'pending-success', 'api-error']) {
  it(`waits for and reports SSM result using mocks: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'develop-ssm-'));
    try {
      put(
        root,
        'bin/aws',
        `#!/usr/bin/env bash
set -eu
if [[ "$2" == send-command ]]; then
  while (($#)); do
    if [[ "$1" == --parameters ]]; then cp "\${2#file://}" "$TEST_ROOT/parameters.json"; fi
    shift
  done
  echo command-123
elif [[ "$TEST_MODE" == api-error ]]; then
  echo AccessDeniedException >&2; exit 1
elif [[ "$TEST_MODE" == pending-success && ! -f "$TEST_ROOT/seen" ]]; then
  touch "$TEST_ROOT/seen"
  echo InvocationDoesNotExist >&2; exit 1
else
  status=$TEST_MODE
  if [[ "$status" == pending-success ]]; then status=Success; fi
  printf '{"Status":"%s","StandardOutputContent":"deployment stdout","StandardErrorContent":"deployment stderr"}' "$status"
fi
`
      );
      put(root, 'bin/sleep', '#!/usr/bin/env bash\n:');
      for (const name of ['aws', 'sleep']) chmodSync(join(root, 'bin', name), 0o755);
      const result = spawnSync('bash', [resolve('scripts/deploy/send-develop.sh')], {
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          DEPLOY_SHA: sha,
          DEVELOP_ARTIFACT_BUCKET: 'test-bucket',
          DEVELOP_INSTANCE_ID: 'i-123abc',
          AWS_REGION: 'us-east-1',
          TEST_ROOT: root,
          TEST_MODE: mode,
        },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(
        ['Success', 'pending-success'].includes(mode) ? 0 : 1
      );
      if (mode === 'api-error') expect(result.stderr).toContain('AccessDeniedException');
      else {
        expect(result.stdout).toContain('deployment stdout');
        expect(result.stdout).toContain('deployment stderr');
        expect(result.stdout).toContain('SSM status:');
      }
      const parameters = JSON.parse(readFileSync(join(root, 'parameters.json'), 'utf8'));
      expect(parameters.executionTimeout).toEqual(['2400']);
      expect(parameters.commands[0]).toContain('runuser -u deploy -- bash -s -- test-bucket');
      expect(parameters.commands[0]).not.toContain('sudo bash');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

it('keeps migration tooling in production dependencies for frozen server installs', () => {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  expect(manifest.dependencies.prisma).toEqual(expect.any(String));
  expect(manifest.dependencies.dotenv).toEqual(expect.any(String));
});
