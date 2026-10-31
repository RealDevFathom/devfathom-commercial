// Pure target checks; importing this file never connects to a database or starts an app.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Both Playwright's CommonJS loader and the native TS runner execute at repository root.
export const acceptanceRoot = realpathSync(process.cwd());
export const acceptanceEvidence = resolve(
  acceptanceRoot,
  'restaurant-growth-completion-20261009/runtime'
);
export const acceptanceOrigin = 'http://chai-chowk.localhost:4483';

export type AcceptanceReceipt = {
  environment: 'TEST_SANDBOX';
  repository: string;
  sourceManifestSHA256: string;
  database: string;
  databasePort: number;
  runtimeRole: string;
  ownerRole: string;
  appOrigin: string;
  appPid?: number;
  buildId?: string;
  stages: string[];
};

export function assertAcceptanceDatabase(url: string | undefined, receipt: AcceptanceReceipt) {
  if (!url) throw new Error('Explicit acceptance database required');
  const target = new URL(url);
  if (
    receipt.environment !== 'TEST_SANDBOX' ||
    !/^restaurant_growth_test_[a-z0-9_]+$/.test(receipt.database) ||
    receipt.databasePort !== 55683 ||
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.hostname !== '127.0.0.1' ||
    target.port !== '55683' ||
    target.pathname !== `/${receipt.database}` ||
    decodeURIComponent(target.username) !== receipt.runtimeRole ||
    receipt.runtimeRole !== 'restaurant_acceptance_runtime' ||
    receipt.ownerRole !== 'restaurant_acceptance_owner' ||
    target.search ||
    target.hash
  )
    throw new Error('Database does not match the admitted isolated Restaurant candidate');
  return target.href;
}

export function assertAcceptanceBrowser(baseURL: string | undefined, receipt: AcceptanceReceipt) {
  if (
    baseURL !== acceptanceOrigin ||
    receipt.appOrigin !== acceptanceOrigin ||
    receipt.environment !== 'TEST_SANDBOX' ||
    !receipt.stages.includes('app') ||
    !Number.isSafeInteger(receipt.appPid) ||
    !receipt.buildId
  )
    throw new Error('Configured browser target lacks admitted app/build identity');
  return acceptanceOrigin;
}

export function readAcceptanceReceipt(): AcceptanceReceipt {
  if (process.env.RESTAURANT_ACCEPTANCE_ADMITTED !== '1')
    throw new Error('Separate coordinator admission required; preparation is source only');
  const file = process.env.RESTAURANT_ACCEPTANCE_RUNTIME_RECEIPT;
  if (!file || lstatSync(file).isSymbolicLink() || (lstatSync(file).mode & 0o777) !== 0o600)
    throw new Error('Private runner receipt required');
  const path = realpathSync(file);
  if (
    !path.startsWith(resolve(acceptanceEvidence, 'runs') + '/') ||
    !path.endsWith('/runtime.json')
  )
    throw new Error('Receipt must belong to this candidate runner');
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as AcceptanceReceipt;
  const manifest = readFileSync(resolve(acceptanceEvidence, 'source-manifest.json'));
  if (
    receipt.repository !== acceptanceRoot ||
    receipt.sourceManifestSHA256 !== createHash('sha256').update(manifest).digest('hex') ||
    !receipt.stages.includes('migrate')
  )
    throw new Error('Receipt source/migration identity mismatch');
  return receipt;
}
