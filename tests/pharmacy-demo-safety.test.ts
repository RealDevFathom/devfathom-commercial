/**
 * Run: node --experimental-strip-types --test tests/pharmacy-demo-safety.test.ts
 * Query-contract evidence only: no database, seed entrypoint, or network access.
 * Reviewed data-only contract: scripts/pharmacy-demo-contract.ts at immutable
 * commit 5b00a056775fad283ed305e9e582effcc224b534 (read-only; no runner delivered).
 * PharmacyDemoEvidence contains manual observations, not authorization proof.
 * UNVERIFIED pending actual runner exports: vertical/tenant/branch/owner rejection,
 * approval expiry, DB role fences, real-row/receipt drift, concurrency/replay,
 * external sends, and credential/permission/activation write refusal.
 * These query-shape checks are not authentication, RLS, or root-package proof.
 * Bind behavioral cases to real runner exports after immutable source delivery;
 * missing source is a dependency, not a failing or skipped product test.
 */
import assert from 'node:assert/strict';
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
