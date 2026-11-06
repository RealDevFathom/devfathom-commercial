import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const requiredBuilderSteps = [
  'node node_modules/prisma/build/index.js generate',
  'node node_modules/next/dist/bin/next typegen',
  'node node_modules/typescript/bin/tsc --noEmit',
  'AUTH_SECRET=container-build-only node node_modules/next/dist/bin/next build',
];

export function checkDockerBuildContract(packageSource, dockerfile) {
  const packageJson = JSON.parse(packageSource);

  // Docker deliberately avoids package-manager shims so the build is guaranteed
  // to use real Node. Keep this executable contract in step with both definitions.
  assert.equal(
    packageJson.scripts?.build,
    'prisma generate && next build',
    'package.json build changed: update Dockerfile and this contract together'
  );

  let previousIndex = -1;
  for (const step of requiredBuilderSteps) {
    const index = dockerfile.indexOf(step);
    assert.notEqual(index, -1, `Dockerfile is missing required builder step: ${step}`);
    assert.ok(index > previousIndex, `Dockerfile builder step is out of order: ${step}`);
    previousIndex = index;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [packageSource, dockerfile] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  ]);
  checkDockerBuildContract(packageSource, dockerfile);
  console.log('Dockerfile and package.json build contracts are synchronized.');
}
