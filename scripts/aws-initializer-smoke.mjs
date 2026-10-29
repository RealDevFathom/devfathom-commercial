// Offline packaging smoke only. Requires checks/offline-guard.cjs from the handoff.
// No baseline data, private input, approval pin, DB or TLS connection is supplied.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as baselineModule from '../prisma/fresh-database-baseline.ts';
import * as fingerprintModule from '../prisma/fresh-database-fingerprint.ts';
import * as runnerModule from '../prisma/fresh-database-runner.ts';
import '../prisma/fresh-database-adapter.ts';
import '../prisma/fresh-database-observer.ts';
import '../prisma/fresh-database-prep.ts';
import '../prisma/fresh-database-migrate.config.ts';
const baseline = baselineModule.default || baselineModule;
const fingerprint = fingerprintModule.default || fingerprintModule;
const runner = runnerModule.default || runnerModule;
const paths = baseline.sourceContextPaths(process.cwd());
const source = Object.fromEntries(paths.map((p) => [p, fingerprint.sha256(fs.readFileSync(p))]));
baseline.verifySourceContext(process.cwd(), source);
assert.throws(() =>
  baseline.verifySourceContext(process.cwd(), { ...source, 'prisma/schema.prisma': '0'.repeat(64) })
);
await assert.rejects(
  runner.loadPrivateConfig('not-read-without-approval'),
  /Independent approval required/
);
console.log(
  JSON.stringify({
    outcome: 'OFFLINE_CONTEXT_OK',
    sourceFiles: paths.length,
    tamperRejected: true,
    missingApprovalRejected: true,
  })
);
