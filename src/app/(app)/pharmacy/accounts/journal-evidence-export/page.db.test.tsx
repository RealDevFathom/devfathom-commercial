// @vitest-environment node
/** Real report/ABAC/entitlement/audit/RLS path; requires a migrated disposable TEST_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TenantActor } from '@/lib/tenancy/tenant-actor';
import {
  journalEvidenceCsv,
  type JournalEvidencePage,
} from '@/lib/pharmacy/accounts/journal-evidence-export';

const harness = vi.hoisted(() => ({ actor: vi.fn(), db: null as ScopedDb | null }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: harness.actor }));
// Supply the test's transaction at the request boundary. All security decisions,
// entitlement resolution, report queries, and audit writes remain real.
vi.mock('@/server/trpc', async () => {
  const actual = await vi.importActual<typeof import('@/server/trpc')>('@/server/trpc');
  return {
    ...actual,
    createTRPCContext: (opts: Parameters<typeof actual.createTRPCContext>[0]) =>
      actual.createTRPCContext({ ...opts, db: harness.db!, auditDb: harness.db! }),
  };
});

import Page from './page';
import { JournalEvidenceExportButton } from './export-button';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const org = `export695_${randomUUID()}`;
const otherOrg = `${org}_other`;
const branch = `${org}_branch`;
const otherBranch = `${org}_other_branch`;
const user = `${org}_owner`;
const query = { branch, from: '2026-10-01', to: '2026-10-02', page: '1' };
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

function evidenceFrom(tree: ReactNode): JournalEvidencePage | null {
  let evidence: JournalEvidencePage | null = null;
  Children.forEach(tree, (child) => {
    if (!isValidElement<{ evidence?: JournalEvidencePage; children?: ReactNode }>(child)) return;
    if (child.type === JournalEvidenceExportButton) evidence = child.props.evidence!;
    else evidence ??= evidenceFrom(child.props.children);
  });
  return evidence;
}

async function read(overrides: Partial<typeof query> = {}) {
  return withTenantDb(org, async (db) => {
    harness.db = db;
    return Page({ searchParams: Promise.resolve({ ...query, ...overrides }) });
  });
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  const { seedDepartments, ensurePlatformModule } = await import('@/lib/test-support/departments');
  withTenantDb = scoped.withTenantDb;
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  const module = await scoped.withPlatformDb(async (db) => {
    await db.organization.createMany({
      data: [org, otherOrg].map((id) => ({
        id,
        slug: id,
        legalName: id,
        displayName: id,
        vertical: 'PHARMACY' as const,
        status: 'ACTIVE' as const,
        deploymentMode: 'SHARED' as const,
      })),
    });
    return ensurePlatformModule(db, 'pharmacy-reports', {
      name: 'Pharmacy reports',
      category: 'Pharmacy',
    });
  });
  for (const organizationId of [org, otherOrg]) {
    await withTenantDb(organizationId, async (db) => {
      await seedDepartments(db, [organizationId], ['LEADERSHIP']);
      await db.organizationModule.create({ data: { moduleId: module.id, status: 'ENABLED' } });
      await db.pharmacyBranch.create({
        data: {
          id: organizationId === org ? branch : otherBranch,
          code: 'MAIN',
          name: 'Main pharmacy',
          addressLine: '1 Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      const role = await db.organizationRole.create({
        data: {
          key: 'owner',
          name: 'Owner',
          permissions: {
            create: [
              { capability: 'reports:operational', effect: 'ALLOW' },
              { capability: 'reports:financial', effect: 'ALLOW' },
            ],
          },
        },
      });
      await db.user.create({
        data: {
          id: organizationId === org ? user : `${otherOrg}_owner`,
          name: 'Owner',
          email: `${organizationId}@example.test`,
          department: 'LEADERSHIP',
          title: 'Owner',
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRoleId: role.id,
        },
      });
      for (let index = 0; index < (organizationId === org ? 26 : 1); index++) {
        await db.financeJournalEntry.create({
          data: {
            id: `${organizationId}_entry_${String(index).padStart(2, '0')}`,
            branchId: organizationId === org ? branch : otherBranch,
            sourceKind: 'PHARMACY_SALE_LINE',
            sourceId: `=source-${index}`,
            description: 'Journal evidence',
            currency: 'PKR',
            actorId: user,
            occurredAt: new Date('2026-10-01T12:00:00Z'),
            idempotencyKey: `entry-${index}`,
            lines: {
              create: [
                {
                  branchId: organizationId === org ? branch : otherBranch,
                  accountCode: 'CASH',
                  side: 'DEBIT',
                  amountMinor: 2147483647,
                },
                {
                  branchId: organizationId === org ? branch : otherBranch,
                  accountCode: 'SALES_REVENUE',
                  side: 'CREDIT',
                  amountMinor: 2147483647,
                },
              ],
            },
          },
        });
      }
    });
  }
  harness.actor.mockResolvedValue({
    session: {
      expires: '2099-01-01',
      user: { id: user, role: 'ADMIN', status: 'ACTIVE', organizationId: org },
    },
    organization: { id: org, vertical: 'PHARMACY', status: 'ACTIVE' },
    support: null,
  } as TenantActor);
}, 30_000);

suite('journal export through the real tenant report boundary', () => {
  it('exports only the selected 25 of 26 postings with exact Int amounts and a persisted read audit', async () => {
    const tree = await read();
    const evidence = evidenceFrom(tree)!;
    expect(evidence).toMatchObject({ page: 1, journalCount: 26 });
    expect(evidence.journal).toHaveLength(25);
    expect(evidence.journal.every((entry) => entry.id.startsWith(`${org}_entry_`))).toBe(true);
    expect(evidence.journal[0]!.lines[0]!.amountMinor).toBe('2147483647');
    expect(evidence).not.toHaveProperty('accounts');
    const csv = journalEvidenceCsv(evidence);
    expect(csv).toContain('"partial","coverage-unknown"');
    expect(csv).toContain('"\'=source-');
    expect(csv.split('\r\n')).toHaveLength(52);
    expect(csv).not.toContain(otherOrg);
    const audits = await withTenantDb(org, (db) =>
      db.auditLog.findMany({
        where: {
          actorId: user,
          action: 'financialStatements',
          outcome: 'SUCCESS',
          operation: 'READ',
        },
      })
    );
    expect(audits).toHaveLength(1);
  });

  it('keeps coverage metadata on an out-of-range page', async () => {
    const evidence = evidenceFrom(await read({ page: '3' }))!;
    expect(evidence.journal).toEqual([]);
    expect(journalEvidenceCsv(evidence)).toContain(
      '"3","25","0","26","partial","coverage-unknown"'
    );
  });

  it('does not export a foreign branch, and RLS hides its postings even from a direct reader', async () => {
    expect(evidenceFrom(await read({ branch: otherBranch }))).toBeNull();
    const { financialStatements } = await import('@/lib/pharmacy/financial-statements');
    const foreign = await withTenantDb(org, (db) =>
      financialStatements(
        db,
        { organizationId: otherOrg, branchId: otherBranch },
        { from: new Date(query.from), to: new Date(query.to), page: 1 }
      )
    );
    expect(foreign.journalCount).toBe(0);
    expect(foreign.journal).toEqual([]);
  });

  it('honors a stored financial-report DENY for an ADMIN', async () => {
    await withTenantDb(org, (db) =>
      db.userPermissionOverride.create({
        data: {
          userId: user,
          capability: 'reports:financial',
          effect: 'DENY',
          reason: 'Export acceptance',
        },
      })
    );
    try {
      const tree = await read();
      expect(evidenceFrom(tree)).toBeNull();
      expect(renderToStaticMarkup(tree)).toContain('Permission required');
    } finally {
      await withTenantDb(org, (db) =>
        db.userPermissionOverride.deleteMany({ where: { userId: user } })
      );
    }
  });

  it('does not export after the reports entitlement is revoked', async () => {
    await withTenantDb(org, (db) =>
      db.organizationModule.updateMany({ data: { status: 'DISABLED' } })
    );
    const tree = await read();
    expect(evidenceFrom(tree)).toBeNull();
    expect(renderToStaticMarkup(tree)).toContain('Permission required');
  });
});
