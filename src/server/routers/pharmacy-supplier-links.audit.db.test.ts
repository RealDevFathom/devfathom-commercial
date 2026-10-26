/**
 * Supplier signed-link audit persistence against a real migrated PostgreSQL.
 *
 * Requires TEST_DATABASE_URL (a disposable database reached as the restricted
 * runtime role). Without it, this suite reports itself skipped. The supplier
 * operation is stubbed so this test isolates the router-to-audit persistence
 * boundary; the audit implementation, tenant transaction, and database are real.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/pharmacy/supplier-action-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/supplier-action-links')>();
  return {
    ...actual,
    getSupplierLinkAuditTarget: vi.fn(),
    submitSupplierEvidence: vi.fn(),
  };
});

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORGANIZATION = `supplier_audit_org_${suffix}`;
const BRANCH = `supplier_audit_branch_${suffix}`;
const LINK = `supplier_audit_link_${suffix}`;

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  flushAuditWritesForTest: (typeof import('@/server/audit'))['flushAuditWritesForTest'];
  router: (typeof import('./pharmacy-supplier-links'))['pharmacySupplierLinksRouter'];
};

let deps: Deps;

describeIfDatabase('pharmacy supplier signed-link audit persistence', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(scopedDb.withPlatformDb);

    deps = {
      ...scopedDb,
      flushAuditWritesForTest: (await import('@/server/audit')).flushAuditWritesForTest,
      router: (await import('./pharmacy-supplier-links')).pharmacySupplierLinksRouter,
    };

    await deps.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: ORGANIZATION,
          slug: ORGANIZATION.replaceAll('_', '-'),
          legalName: 'Supplier audit persistence test',
          displayName: 'Supplier audit persistence test',
          status: 'ACTIVE',
          vertical: 'PHARMACY',
        },
      })
    );
  }, 60_000);

  it('durably writes tenant, branch, link, action, and outcome', async () => {
    const { getSupplierLinkAuditTarget, submitSupplierEvidence } = await import(
      '@/lib/pharmacy/supplier-action-links'
    );
    vi.mocked(getSupplierLinkAuditTarget).mockResolvedValue({
      id: LINK,
      organizationId: ORGANIZATION,
      branchId: BRANCH,
    });
    vi.mocked(submitSupplierEvidence).mockResolvedValue({ id: `submission_${suffix}` } as never);

    await deps.withTenantDb(ORGANIZATION, async (db) => {
      const caller = deps.router.createCaller({
        db,
        entitlements: { organizationId: ORGANIZATION },
        requestMeta: { ip: '192.0.2.10', userAgent: 'supplier-audit-test' },
      } as never);
      await caller.submit({
        token: 'link.secret.signature',
        kind: 'ACKNOWLEDGEMENT',
        idempotencyKey: `idem_${suffix}`,
        payload: {},
      });
    });
    await deps.flushAuditWritesForTest();

    const row = await deps.withTenantDb(ORGANIZATION, (db) =>
      db.auditLog.findFirst({
        where: { action: 'pharmacySupplierLinks.submit', targetId: LINK },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(row).toMatchObject({
      organizationId: ORGANIZATION,
      action: 'pharmacySupplierLinks.submit',
      targetType: 'PharmacySupplierActionLink',
      targetId: LINK,
      outcome: 'SUCCESS',
      ip: '192.0.2.10',
      userAgent: 'supplier-audit-test',
      metadata: { branchId: BRANCH, linkId: LINK, kind: 'ACKNOWLEDGEMENT' },
    });
  });
});
