/**
 * Run: node --experimental-strip-types --test tests/pharmacy-demo-safety.test.ts
 * Query-contract evidence only: no database, seed entrypoint, or network access.
 * Root availability deliberately fails until Desktop routes immutable source.
 * Availability alone is not root-package safety acceptance; bind behavioral
 * cases to its real exports after delivery, without importing an executable main.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  findBranch,
  getBranchPurchaseOrder,
  listBranchPurchaseOrders,
} from '../src/lib/pharmacy/branch-scope.ts';

type Db = Parameters<typeof findBranch>[0];

for (const scope of [
  { organizationId: 'synthetic-tenant-a', branchId: 'synthetic-branch-a' },
  { organizationId: 'synthetic-tenant-b', branchId: 'synthetic-branch-a' },
  { organizationId: 'synthetic-tenant-a', branchId: 'synthetic-branch-b' },
]) {
  test(`branch lookup retains both predicates: ${JSON.stringify(scope)}`, async () => {
    let calls = 0;
    const db = {
      pharmacyBranch: {
        async findFirst(query: unknown) {
          calls++;
          assert.deepEqual(query, {
            where: { organizationId: scope.organizationId, id: scope.branchId },
          });
          return null;
        },
      },
    } as unknown as Db;
    assert.equal(await findBranch(db, scope), null);
    assert.equal(calls, 1);
  });

  test(`purchase reads retain tenant and branch: ${JSON.stringify(scope)}`, async () => {
    const queries: { where: unknown }[] = [];
    const db = {
      pharmacyPurchaseOrder: {
        async findFirst(query: { where: unknown }) {
          queries.push(query);
          return null;
        },
        async findMany(query: { where: unknown }) {
          queries.push(query);
          return [];
        },
      },
    } as unknown as Db;
    assert.equal(await getBranchPurchaseOrder(db, scope, 'synthetic-foreign-order'), null);
    assert.deepEqual(await listBranchPurchaseOrders(db, scope), []);
    assert.deepEqual(queries.map(({ where }) => where), [
      { ...scope, id: 'synthetic-foreign-order' },
      scope,
    ]);
  });
}

test('root-package prerequisite: immutable contract and runner delivered', () => {
  const missing = ['pharmacy-demo-contract.ts', 'seed-pharmacy-demo.ts'].filter(
    (file) => !existsSync(new URL(`../scripts/${file}`, import.meta.url)),
  );
  assert.deepEqual(missing, [], `source-not-delivered: ${missing.join(', ')}. ` +
    'UNVERIFIED: vertical/tenant/branch/owner rejection; missing/expired approval; ' +
    'mismatched/privileged DB role; real-row/receipt drift; concurrency/replay; ' +
    'external sends; credential/permission/activation writes.');
});
