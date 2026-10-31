/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { createGeneralJournalDraft, postGeneralJournal, reverseGeneralJournal } from '@/lib/pharmacy/accounts/general-journal';
import { authorizePharmacyGeneralJournal, authorizePharmacyGeneralJournalCollection } from './pharmacy-general-journal-security';
import type { TRPCContext } from './trpc';

const runtimeUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const ownerUrl = process.env.M8_TEST_OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const tag = randomUUID().replaceAll('-', '');
const organizationId = `jv_audit_${tag}`;
const actorId = `jv_actor_${tag}`;
const branchId = `jv_branch_${tag}`;
let owner: pg.Client;

describeDatabase('durable pharmacy journal admission', () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    await owner.query(`INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
      VALUES ($1, $1, 'Journal audit test', 'Journal audit test', 'ACTIVE', 'SHARED', now(), now())`, [organizationId]);
    await owner.query(`INSERT INTO organization_departments (id, "organizationId", key, name, "createdAt", "updatedAt")
      VALUES ($1, $2, 'finance', 'Finance', now(), now())`, [randomUUID(), organizationId]);
    await owner.query(`INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
      VALUES ($1, $2, 'Journal tester', $3, 'ADMIN', 'finance', 'Accountant', now())`, [actorId, organizationId, `${tag}@example.test`]);
    await owner.query(`INSERT INTO user_permission_overrides (id, "organizationId", "userId", capability, effect, reason, "updatedAt")
      VALUES ($1, $2, $3, 'reports:financial', 'ALLOW', 'Journal audit fixture', now())`, [randomUUID(), organizationId, actorId]);
    await owner.query(`INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "createdAt", "updatedAt")
      VALUES ($1, $2, $1, 'Journal test', '1 Test Road', 'Lahore', 'PB', now(), now())`, [branchId, organizationId]);
  });
  afterAll(async () => { await owner?.end(); });

  it.each(['branch', 'collection'] as const)('commits %s admission before a business transaction fails', async (kind) => {
    await expect(withTenantDb(organizationId, async (db) => {
      const roles = await db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(roles[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const ctx = {
        db, session: { user: { id: actorId, role: 'ADMIN', status: 'ACTIVE' } },
        organization: { id: organizationId },
        entitlements: { organizationId, enabledModules: ['pharmacy-finance'], modules: [{ key: 'pharmacy-finance', enabled: true }] },
        requestMeta: { ip: null },
      } as unknown as TRPCContext;
      if (kind === 'branch') await authorizePharmacyGeneralJournal(ctx, branchId);
      else await authorizePharmacyGeneralJournalCollection(ctx);
      throw new Error('business rollback');
    }, { userId: actorId })).rejects.toThrow('business rollback');

    const action = kind === 'branch' ? 'pharmacyGeneralJournal.admission' : 'pharmacyGeneralJournal.collectionAdmission';
    const rows = await owner.query(`SELECT result, outcome FROM audit_logs WHERE "organizationId" = $1 AND action = $2`, [organizationId, action]);
    expect(rows.rows).toEqual([{ result: { decision: 'ADMITTED' }, outcome: 'SUCCESS' }]);
  });

  it('blocks forged posted inserts and posted/reversed deletion through the runtime role', async () => {
    const scope = { organizationId, actorId, branchId };
    const values = { reference: `JV-${tag}`, purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
      amountMinor: 12345, currency: 'USD' as const, occurredAt: new Date('2026-10-25T12:00:00Z'),
      evidence: 'invoice', reason: 'accrual', idempotencyKey: randomUUID() };
    await expect(withTenantDb(organizationId, (db) => db.pharmacyGeneralJournalDocument.create({ data: {
      organizationId, branchId, reference: `forged-${tag}`, purpose: values.purpose,
      amountMinor: values.amountMinor, currency: values.currency, occurredAt: values.occurredAt,
      evidence: values.evidence, reason: values.reason, status: 'POSTED',
      createKey: randomUUID(), createPayloadHash: 'forged', createdByUserId: actorId,
    } }))).rejects.toThrow(/unposted drafts/);

    const draft = await withTenantDb(organizationId, (db) => createGeneralJournalDraft(db, scope, values));
    const posted = await withTenantDb(organizationId, (db) => postGeneralJournal(db, scope, {
      documentId: draft.id, version: draft.version, idempotencyKey: randomUUID(),
    }));
    await expect(withTenantDb(organizationId, (db) => db.pharmacyGeneralJournalDocument.delete({ where: { id: draft.id } })))
      .rejects.toThrow(/cannot be deleted/);
    const reversed = await withTenantDb(organizationId, (db) => reverseGeneralJournal(db, scope, {
      documentId: draft.id, version: posted.version, idempotencyKey: randomUUID(),
      at: new Date('2026-10-26T12:00:00Z'), reason: 'correction',
    }));
    await expect(withTenantDb(organizationId, (db) => db.pharmacyGeneralJournalDocument.delete({ where: { id: reversed.id } })))
      .rejects.toThrow(/cannot be deleted/);
    expect(await withTenantDb(organizationId, (db) => db.financeJournalEntry.count({ where: { sourceId: draft.id } }))).toBe(2);
  });
});
