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
vi.mock('@/lib/auth/anonymous-tenant', () => ({
  organizationForAnonymousToken: vi.fn(async () => ORGANIZATION),
}));
vi.mock('@/lib/pharmacy/supplier-action-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/supplier-action-links')>();
  return {
    ...actual,
    compensateSupplierDocumentUpload: vi.fn(),
    getSupplierLinkAuditTarget: vi.fn(),
    submitSupplierEvidence: vi.fn(),
    uploadSupplierDocument: vi.fn(),
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
  post: (typeof import('@/app/api/trpc/[trpc]/route'))['POST'];
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
      post: (await import('@/app/api/trpc/[trpc]/route')).POST,
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

  it('durably writes a failed supplier action', async () => {
    const { SupplierLinkError, getSupplierLinkAuditTarget, submitSupplierEvidence } = await import(
      '@/lib/pharmacy/supplier-action-links'
    );
    vi.mocked(getSupplierLinkAuditTarget).mockResolvedValue({
      id: LINK,
      organizationId: ORGANIZATION,
      branchId: BRANCH,
    });
    vi.mocked(submitSupplierEvidence).mockRejectedValue(new SupplierLinkError('MISMATCH'));

    await expect(
      deps.withTenantDb(ORGANIZATION, async (db) => {
        const caller = deps.router.createCaller({
          db,
          entitlements: { organizationId: ORGANIZATION },
          requestMeta: { ip: '192.0.2.11', userAgent: 'supplier-audit-failure-test' },
        } as never);
        return caller.submit({
          token: 'link.secret.signature',
          kind: 'REJECTION',
          idempotencyKey: `idem_failure_${suffix}`,
          payload: {},
        });
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'MISMATCH' });
    await deps.flushAuditWritesForTest();

    const row = await deps.withTenantDb(ORGANIZATION, (db) =>
      db.auditLog.findFirst({
        where: {
          action: 'pharmacySupplierLinks.submit',
          targetId: LINK,
          outcome: 'FAILURE',
        },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(row).toMatchObject({
      organizationId: ORGANIZATION,
      action: 'pharmacySupplierLinks.submit',
      targetType: 'PharmacySupplierActionLink',
      targetId: LINK,
      outcome: 'FAILURE',
      errorCode: 'MISMATCH',
      errorMessage: 'MISMATCH',
      ip: '192.0.2.11',
      userAgent: 'supplier-audit-failure-test',
      metadata: { branchId: BRANCH, linkId: LINK, kind: 'REJECTION' },
    });
  });

  it('keeps a failed supplier audit after the HTTP request transaction rolls back', async () => {
    const { SupplierLinkError, getSupplierLinkAuditTarget, submitSupplierEvidence } = await import(
      '@/lib/pharmacy/supplier-action-links'
    );
    vi.mocked(getSupplierLinkAuditTarget).mockResolvedValue({
      id: LINK,
      organizationId: ORGANIZATION,
      branchId: BRANCH,
    });
    vi.mocked(submitSupplierEvidence).mockRejectedValue(new SupplierLinkError('MISMATCH'));

    const response = await deps.post(
      new Request('http://supplier.example/api/trpc/pharmacySupplierLinks.submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'supplier-http-audit-test' },
        body: JSON.stringify({
          json: {
            token: 'link.secret.signature',
            kind: 'REJECTION',
            idempotencyKey: `idem_http_failure_${suffix}`,
            payload: {},
          },
        }),
      })
    );
    expect(response.status).toBe(400);
    await deps.flushAuditWritesForTest();

    const row = await deps.withTenantDb(ORGANIZATION, (db) =>
      db.auditLog.findFirst({
        where: {
          action: 'pharmacySupplierLinks.submit',
          targetId: LINK,
          outcome: 'FAILURE',
          userAgent: 'supplier-http-audit-test',
        },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(row).toMatchObject({
      organizationId: ORGANIZATION,
      outcome: 'FAILURE',
      errorCode: 'MISMATCH',
      userAgent: 'supplier-http-audit-test',
    });
  });

  it('durably writes a successful document upload', async () => {
    const { getSupplierLinkAuditTarget, uploadSupplierDocument } = await import(
      '@/lib/pharmacy/supplier-action-links'
    );
    vi.mocked(getSupplierLinkAuditTarget).mockResolvedValue({
      id: LINK,
      organizationId: ORGANIZATION,
      branchId: BRANCH,
    });
    vi.mocked(uploadSupplierDocument).mockResolvedValue({
      document: { id: `document_${suffix}` },
      storedObjectCreated: false,
    } as never);

    await deps.withTenantDb(ORGANIZATION, async (db) => {
      const caller = deps.router.createCaller({
        db,
        entitlements: { organizationId: ORGANIZATION },
        requestMeta: { ip: '192.0.2.12', userAgent: 'supplier-upload-audit-test' },
      } as never);
      await caller.uploadDocument({
        token: 'link.secret.signature',
        idempotencyKey: `idem_document_${suffix}`,
        fileName: 'invoice.pdf',
        declaredMimeType: 'application/pdf',
        contentBase64: 'JVBERg==',
      });
    });

    const row = await deps.withTenantDb(ORGANIZATION, (db) =>
      db.auditLog.findFirst({
        where: { action: 'pharmacySupplierLinks.uploadDocument', targetId: LINK },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(row).toMatchObject({
      organizationId: ORGANIZATION,
      action: 'pharmacySupplierLinks.uploadDocument',
      targetType: 'PharmacySupplierActionLink',
      targetId: LINK,
      outcome: 'SUCCESS',
      ip: '192.0.2.12',
      userAgent: 'supplier-upload-audit-test',
      metadata: { branchId: BRANCH, linkId: LINK, kind: 'DOCUMENT' },
    });
  });
});
