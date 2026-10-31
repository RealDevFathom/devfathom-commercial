// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '');
const orgA = `wa_compliance_a_${suffix}`;
const orgB = `wa_compliance_b_${suffix}`;
let branchA: string;
let sibling: string;
let foreign: string;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let approveMarketingTemplate: typeof import('../marketing-service').approveMarketingTemplate;
let compliance: typeof import('./compliance-linter');

function inScope<T>(organizationId: string, branchId: string, run: (db: ScopedDb) => Promise<T>) {
  return withTenantDb(organizationId, async (db) => {
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branchId);
    return run(db);
  });
}

const logData = (organizationId: string, branchId: string) => ({
  id: randomUUID(),
  organizationId,
  branchId,
  subject: 'test:scope',
  intent: 'UTILITY',
  outcome: 'PASS',
  reasons: [],
  linterVersion: 'test',
});

beforeAll(async () => {
  if (!url) return;
  ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
  ({ approveMarketingTemplate } = await import('../marketing-service'));
  compliance = await import('./compliance-linter');
  const roles = await withTenantDb(orgA, (db) =>
    db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  // A superuser would make the branch/tenant assertions meaningless.
  expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const organizationId of [orgA, orgB]) {
    await withTenantDb(organizationId, async (db) => {
      await db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'Compliance test',
          displayName: 'Compliance test',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          currency: 'PKR',
        },
      });
      const createBranch = (code: string) =>
        db.pharmacyBranch.create({
          data: {
            organizationId,
            code,
            name: code,
            addressLine: '1 Test Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
      const branch = await createBranch('MAIN');
      if (organizationId === orgA) {
        branchA = branch.id;
        sibling = (await createBranch('SIBLING')).id;
        await db.medicine.create({
          data: {
            organizationId,
            productName: 'Panadol 500mg',
            productFamily: 'PHARMACEUTICAL',
          },
        });
        await db.medicine.create({
          data: {
            organizationId,
            productName: 'Toothbrush',
            productFamily: 'FRONT_SHOP',
          },
        });
      } else foreign = branch.id;
    });
  }
  for (const [organizationId, branchId] of [
    [orgA, branchA],
    [orgA, sibling],
    [orgB, foreign],
  ]) {
    await inScope(organizationId, branchId, (db) =>
      db.pharmacyWhatsAppComplianceLog.create({ data: logData(organizationId, branchId) })
    );
  }
});

suite('WhatsApp compliance evidence under forced PostgreSQL RLS', () => {
  it('hides sibling and foreign evidence without application scope predicates', async () => {
    const rows = await inScope(orgA, branchA, (db) => db.pharmacyWhatsAppComplianceLog.findMany());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.organizationId === orgA && row.branchId === branchA)).toBe(true);
  });

  it('allows organization-wide reads when the branch setting is empty', async () => {
    const rows = await inScope(orgA, '', (db) => db.pharmacyWhatsAppComplianceLog.findMany());
    expect(new Set(rows.map((row) => row.branchId))).toEqual(new Set([branchA, sibling]));
    expect(rows.every((row) => row.organizationId === orgA)).toBe(true);
  });

  it('rejects sibling and foreign inserts, including a foreign branch reference', async () => {
    for (const [organizationId, branchId] of [
      [orgA, sibling],
      [orgB, foreign],
      [orgA, foreign],
    ]) {
      await expect(
        inScope(orgA, branchA, (db) =>
          db.pharmacyWhatsAppComplianceLog.create({ data: logData(organizationId, branchId) })
        )
      ).rejects.toThrow();
    }
  });

  it('keeps blocked approval evidence after rollback, before returning the rejection', async () => {
    const name = `blocked-${randomUUID()}`;
    await expect(
      inScope(orgA, branchA, (db) =>
        approveMarketingTemplate(
          db,
          {
            organizationId: orgA,
            branchId: branchA,
            actorId: 'owner-test',
            timezone: 'UTC',
          },
          { branchId: branchA, name, body: 'Panadol available. Reply STOP.', reviewed: true }
        )
      )
    ).rejects.toThrow('WhatsApp compliance blocked');
    const logs = await inScope(orgA, branchA, (db) =>
      db.pharmacyWhatsAppComplianceLog.findMany({
        where: { subject: `template:${name}` },
      })
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organizationId: orgA,
      branchId: branchA,
      actorId: 'owner-test',
      outcome: 'BLOCK',
      intent: 'MARKETING',
      linterVersion: compliance.WHATSAPP_COMPLIANCE_LINTER_VERSION,
      reasons: [{ code: 'REGULATED_TERM', term: 'panadol', source: 'CATALOG' }],
    });
    expect(
      await inScope(orgA, branchA, (db) => db.pharmacyMarketingTemplate.count({ where: { name } }))
    ).toBe(0);
  });

  it('retains exactly one decision if a caller catches the rejection and commits', async () => {
    const name = `caught-${randomUUID()}`;
    await inScope(orgA, branchA, async (db) => {
      await expect(
        approveMarketingTemplate(
          db,
          {
            organizationId: orgA,
            branchId: branchA,
            actorId: 'owner-test',
            timezone: 'UTC',
          },
          { branchId: branchA, name, body: 'Panadol available. Reply STOP.', reviewed: true }
        )
      ).rejects.toThrow('WhatsApp compliance blocked');
    });
    expect(
      await inScope(orgA, branchA, (db) =>
        db.pharmacyWhatsAppComplianceLog.count({
          where: { subject: `template:${name}` },
        })
      )
    ).toBe(1);
  });

  it('does not let independent persistence bypass the original branch authorization', async () => {
    const name = `unauthorized-${randomUUID()}`;
    await expect(
      inScope(orgA, branchA, (db) =>
        approveMarketingTemplate(
          db,
          {
            organizationId: orgA,
            branchId: sibling,
            actorId: 'owner-test',
            timezone: 'UTC',
          },
          { branchId: sibling, name, body: 'Panadol available. Reply STOP.', reviewed: true }
        )
      )
    ).rejects.toThrow();
    expect(
      await inScope(orgA, '', (db) =>
        db.pharmacyWhatsAppComplianceLog.count({
          where: { subject: `template:${name}` },
        })
      )
    ).toBe(0);
  });

  it('preserves retail marketing while blocking unqualified drug names from the real catalog', async () => {
    const catalog = await inScope(orgA, branchA, (db) =>
      compliance.readComplianceCatalog(db, orgA)
    );
    expect(
      compliance.lintWhatsAppContent({
        templateText: 'Toothbrush available. Reply STOP.',
        intent: 'MARKETING',
        catalog,
      }).outcome
    ).toBe('PASS');
    expect(
      compliance.lintWhatsAppContent({
        templateText: 'Panadol available. Reply STOP.',
        intent: 'MARKETING',
        catalog,
      }).outcome
    ).toBe('BLOCK');
  });

  it('keeps ordinary logs transactional and append-only', async () => {
    const data = logData(orgA, branchA);
    await expect(
      inScope(orgA, branchA, async (db) => {
        await db.pharmacyWhatsAppComplianceLog.create({ data });
        throw new Error('unrelated failure');
      })
    ).rejects.toThrow('unrelated failure');
    expect(
      await inScope(orgA, branchA, (db) =>
        db.pharmacyWhatsAppComplianceLog.count({ where: { id: data.id } })
      )
    ).toBe(0);
    const log = await inScope(orgA, branchA, (db) =>
      db.pharmacyWhatsAppComplianceLog.create({ data })
    );
    await expect(
      inScope(orgA, branchA, (db) =>
        db.pharmacyWhatsAppComplianceLog.update({
          where: { id: log.id },
          data: { outcome: 'WARN' },
        })
      )
    ).rejects.toThrow('append-only');
    await expect(
      inScope(orgA, branchA, (db) =>
        db.pharmacyWhatsAppComplianceLog.delete({
          where: { id: log.id },
        })
      )
    ).rejects.toThrow('append-only');
  });
});
