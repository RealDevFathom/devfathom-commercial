/** Give the opt-in browser Vitest matrix a production app and retain its exact totals. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  const evidence = resolve('gate/platform-login');
  mkdirSync(evidence, { recursive: true });
  const baseURL = 'http://127.0.0.1:4324';
  const server = spawn(process.execPath, ['scripts/start-standalone.mjs'], {
    // This lane owns the loopback app and models one local proxy hop, as
    // the other production browser lanes do. Keep production startup checks active.
    env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: '4324', TRUSTED_PROXY_HOPS: '1' },
    stdio: [
      'ignore',
      openSync(resolve(evidence, 'app.stdout.log'), 'w'),
      openSync(resolve(evidence, 'app.stderr.log'), 'w'),
    ],
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null) throw new Error('Accessibility app exited before readiness.');
      try {
        const response = await fetch(baseURL + '/platform/login', {
          headers: { 'x-forwarded-host': 'admin.localhost:4324' },
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for this owned server to start. */
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
    if (!ready) throw new Error('Accessibility app did not become ready.');
    const result = spawnSync(
      'bunx',
      [
        'vitest',
        'run',
        'tests/platform-login-accessibility.browser.test.ts',
        '--maxWorkers=1',
        '--reporter=json',
        '--outputFile=' + resolve('gate/vitest-platform-login.json'),
      ],
      {
        env: { ...process.env, PLATFORM_QA_BASE_URL: baseURL },
        stdio: [
          'ignore',
          openSync(resolve(evidence, 'vitest.stdout.log'), 'w'),
          openSync(resolve(evidence, 'vitest.stderr.log'), 'w'),
        ],
      }
    );
    process.exitCode = result.status ?? 1;
  } finally {
    server.kill('SIGTERM');
    await new Promise<void>((done) => {
      if (server.exitCode !== null) done();
      else server.once('exit', () => done());
    });
  }
}
main().catch(() => {
  console.error('Platform login accessibility failed; inspect retained lane logs.');
  process.exitCode = 1;
});
