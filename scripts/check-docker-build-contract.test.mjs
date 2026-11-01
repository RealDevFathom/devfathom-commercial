import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { checkDockerBuildContract } from './check-docker-build-contract.mjs';

const [packageSource, dockerfile] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
]);

test('the checked-in Docker and package build contracts agree', () => {
  checkDockerBuildContract(packageSource, dockerfile);
});

test('a package build-script addition cannot drift silently', () => {
  const changedPackage = JSON.parse(packageSource);
  changedPackage.scripts.build += ' && node scripts/post-build.mjs';

  assert.throws(
    () => checkDockerBuildContract(JSON.stringify(changedPackage), dockerfile),
    /package\.json build changed/
  );
});

test('a missing or reordered Docker builder step cannot drift silently', () => {
  const withoutPrisma = dockerfile.replace(
    'node node_modules/prisma/build/index.js generate',
    'node node_modules/prisma/build/index.js removed'
  );
  assert.throws(
    () => checkDockerBuildContract(packageSource, withoutPrisma),
    /missing required builder step/
  );

  const reordered = dockerfile.replace(
    'node node_modules/prisma/build/index.js generate',
    'AUTH_SECRET=container-build-only node node_modules/next/dist/bin/next build\nnode node_modules/prisma/build/index.js generate'
  );
  assert.throws(() => checkDockerBuildContract(packageSource, reordered), /out of order/);
});
