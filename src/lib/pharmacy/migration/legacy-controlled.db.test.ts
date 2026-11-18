// @vitest-environment node
/**
 * DEV-854 / DEV-925: the legacy NARCOTICS class on real PostgreSQL.
 *
 * Needs a fully migrated, disposable loopback database:
 * - TEST_DATABASE_URL: a LOGIN NOSUPERUSER NOBYPASSRLS runtime role (every service call runs here);
 * - PHARMACY_TEST_OWNER_DATABASE_URL: a role that can seed both tenants' parent rows.
 * Without both URLs the suite is skipped.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { decideCatalogueEdit, submitCatalogueEdit } from '../catalogue-approvals';
import {
  applyLegacyControlledClass,
  applyLegacyControlledToMedicine,
  hasControlledCorrection,
  hasStagedLegacyControlledRow,
} from './legacy-controlled';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const suite = runtimeUrl && ownerUrl ? describe : describe.skip;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = (label: string) => `lc_${label}_${suffix}`;
const orgA = id('org_a');
const orgB = id('org_b');
const editorId = id('editor');
const reviewerId = id('reviewer');
const medicine = {
  opioid: id('med_opioid'),
  sedative: id('med_sedative'),
  hypnotic: id('med_hypnotic'),
  paracetamol: id('med_paracetamol'),
  otherTenant: id('med_other_tenant'),
};

/** The legacy export's rows, padded as the old system writes them: tabs and line breaks. */
const legacyRows = [
  { productName: 'Synthetic Opioid 50mg', rawPayload: { Name: 'x', classname: '\tNARCOTICS\r\n' } },
  { productName: ' synthetic  opioid 50MG\t', rawPayload: { Name: 'x', CLASS: 'narcotics\n' } },
  { productName: 'Synthetic Sedative 10mg', rawPayload: { Name: 'x', classname: ' Narcotics' } },
  { productName: 'Synthetic Hypnotic 5mg', rawPayload: { Name: 'x', classname: 'NARCOTICS' } },
  {
    productName: 'Synthetic Paracetamol',
    rawPayload: { Name: 'x', classname: 'Example Distributors' },
  },
];

suite('DEV-925 legacy NARCOTICS class on PostgreSQL', () => {
  let owner: pg.Client;
  let db: PrismaClient;
  /** One runtime-role transaction scoped to a tenant, as the app's tenant DB opens it. */
  const tenant = <T>(organizationId: string, run: (tx: ScopedDb) => Promise<T>) =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true),
          set_config('app.is_platform_admin', 'false', true)`;
        return run(tx as ScopedDb);
      },
      { timeout: 30_000 }
    );
  /** The tenant transaction as a client whose own `$transaction` joins it. */
  const joined = (tx: ScopedDb) =>
    new Proxy(tx, {
      get: (target, key) =>
        key === '$transaction'
          ? (run: (client: ScopedDb) => unknown) => run(tx)
          : Reflect.get(target, key),
    });
  const controlled = async (organizationId: string, medicineId: string) =>
    (
      await tenant(organizationId, (tx) =>
        tx.medicine.findFirstOrThrow({ where: { id: medicineId }, select: { controlled: true } })
      )
    ).controlled;
  /** A person's catalogue edit, decided by a second person, through the real edit path. */
  const edit = async (
    medicineId: string,
    changes: Record<string, unknown>,
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
    canReviewControlled = async () => true
  ) => {
    const proposal = await tenant(orgA, (tx) =>
      submitCatalogueEdit(tx, { organizationId: orgA, actorId: editorId }, medicineId, changes)
    );
    await tenant(orgA, (tx) =>
      decideCatalogueEdit(
        joined(tx),
        { organizationId: orgA, actorId: reviewerId, actorOrganizationId: orgA },
        { editId: proposal.id, decision },
        undefined,
        canReviewControlled
      )
    );
  };
  const stage = () => tenant(orgA, (tx) => applyLegacyControlledClass(tx, orgA, legacyRows));

  beforeAll(async () => {
    for (const url of [runtimeUrl!, ownerUrl!])
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Refusing to run legacy class probes against a non-local database.');
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) });
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    for (const organizationId of [orgA, orgB])
      await owner.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "updatedAt")
         VALUES ($1, $1, 'Legacy class fixture', 'Legacy class fixture', 'ACTIVE', now())`,
        [organizationId]
      );
    await owner.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'Pharmacy', 'Pharmacy', now())`,
      [id('department'), orgA]
    );
    for (const userId of [editorId, reviewerId])
      await owner.query(
        `INSERT INTO users (id, "organizationId", name, email, department, title, role, "updatedAt")
         VALUES ($1, $2, 'Pharmacist', $3, 'Pharmacy', 'Pharmacist', 'ADMIN', now())`,
        [userId, orgA, `${userId}@legacy-class.test`]
      );
    const medicines: Array<[string, string, string]> = [
      [medicine.opioid, orgA, 'Synthetic Opioid 50mg'],
      [medicine.sedative, orgA, 'Synthetic Sedative 10mg'],
      [medicine.hypnotic, orgA, 'Synthetic  Hypnotic 5mg'],
      [medicine.paracetamol, orgA, 'Synthetic Paracetamol'],
      [medicine.otherTenant, orgB, 'Synthetic Opioid 50mg'],
    ];
    for (const [medicineId, organizationId, productName] of medicines)
      await owner.query(
        `INSERT INTO pharmacy_medicines (id, "organizationId", "productName", "productFamily", "updatedAt")
         VALUES ($1, $2, $3, 'PHARMACEUTICAL', now())`,
        [medicineId, organizationId, productName]
      );
    // The staged legacy file the confirm step looks up: classes padded with a tab and line break.
    const source = id('source');
    const batch = id('batch');
    await owner.query(
      `INSERT INTO pharmacy_migration_sources
        (id, "organizationId", kind, "fileName", "byteSize", "contentHash")
       VALUES ($1, $2, 'EXCEL_CSV', 'legacy.csv', 1, $3)`,
      [source, orgA, createHash('sha256').update(suffix).digest('hex')]
    );
    await owner.query(
      `INSERT INTO pharmacy_migration_batches
        (id, "organizationId", "sourceId", label, "profilerVersion", "updatedAt")
       VALUES ($1, $2, $3, 'legacy.csv', 'manual-columns/2', now())`,
      [batch, orgA, source]
    );
    const staged: Array<[string, Record<string, string>]> = [
      ['Synthetic Tranquilliser 2mg', { Name: 'x', classname: '\tNARCOTICS\n' }],
      ['Synthetic Antacid', { Name: 'x', classname: '\tExample Distributors\n' }],
    ];
    for (const [index, [productName, rawPayload]] of staged.entries())
      await owner.query(
        `INSERT INTO pharmacy_migration_rows
          (id, "organizationId", "batchId", "sourceKey", "rowNumber", "rawPayload", "targetModelKey", "productName")
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'medicine', $7)`,
        [id(`row_${index}`), orgA, batch, `row:${index + 1}`, index + 1, rawPayload, productName]
      );
  });

  afterAll(async () => {
    await db?.$disconnect();
    await owner?.end();
  });

  it('runs as a restricted role', async () => {
    const [role] = await tenant(
      orgA,
      (tx) =>
        tx.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('finds a staged NARCOTICS class padded with a tab or line break (one trimming rule)', async () => {
    const found = (productName: string) =>
      tenant(orgA, (tx) => hasStagedLegacyControlledRow(tx, orgA, productName));
    expect(await found('synthetic   tranquilliser 2MG ')).toBe(true);
    expect(await found('Synthetic Antacid')).toBe(false);
    // Tenant-scoped: the other organization staged nothing.
    expect(
      await tenant(orgB, (tx) =>
        hasStagedLegacyControlledRow(tx, orgB, 'Synthetic Tranquilliser 2mg')
      )
    ).toBe(false);
  });

  it('flags every NARCOTICS-class medicine at staging, in this tenant only', async () => {
    const result = await stage();
    expect(result).toEqual({
      controlledRows: 4,
      medicineIds: [medicine.hypnotic, medicine.opioid, medicine.sedative].sort(),
      skippedCorrectedRows: 0,
    });
    expect(await controlled(orgA, medicine.opioid)).toBe(true);
    expect(await controlled(orgA, medicine.paracetamol)).toBe(false);
    expect(await controlled(orgB, medicine.otherTenant)).toBe(false);
  });

  it("keeps a person's correction to not controlled when the same file is loaded again", async () => {
    await edit(medicine.opioid, { controlled: false });
    // Not corrections: an edit that never touches the flag, a rejected correction, an approval
    // without the catalogue review grant, and a correction a later approved edit reversed.
    await edit(medicine.hypnotic, { brandName: 'Synthetic brand' });
    await edit(medicine.hypnotic, { controlled: false }, 'REJECT');
    await edit(medicine.sedative, { controlled: false });
    await edit(medicine.sedative, { controlled: true });
    // Without the catalogue review grant the approval is refused (SECURITY.md)...
    await expect(
      edit(medicine.hypnotic, { controlled: false }, 'APPROVE', async () => false)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // ...and an approval with no record of that grant (made before DEV-925) is ignored.
    const ungranted = id('edit_ungranted');
    await owner.query(
      `INSERT INTO pharmacy_catalogue_edits
        (id, "organizationId", "medicineId", "editorId", changes, "expectedUpdatedAt")
       VALUES ($1, $2, $3, $4, '{"controlled": false}'::jsonb, now())`,
      [ungranted, orgA, medicine.hypnotic, editorId]
    );
    await owner.query(
      `UPDATE pharmacy_catalogue_edits
          SET status = 'APPROVED', "reviewerId" = $2, "reviewedAt" = now() + interval '1 hour'
        WHERE id = $1`,
      [ungranted, reviewerId]
    );
    await owner.query(
      `INSERT INTO audit_logs
        (id, "organizationId", "actorId", "actorType", source, category, operation, action,
         "targetType", "targetId", metadata)
       VALUES ($1, $2, $3, 'USER', 'TRPC', 'PHARMACY_CATALOGUE', 'UPDATE',
         'pharmacy.catalogueApproval', 'PharmacyCatalogueEdit', $4,
         '{"soloOwner": false, "pinVerified": false}'::jsonb)`,
      [id('audit_ungranted'), orgA, reviewerId, ungranted]
    );
    // Another path (for example a confirmed reference proposal) cleared these two flags.
    await owner.query(`UPDATE pharmacy_medicines SET controlled = false WHERE id = ANY($1)`, [
      [medicine.hypnotic, medicine.sedative],
    ]);
    expect(await controlled(orgA, medicine.opioid)).toBe(false);

    const correction = (medicineId: string) =>
      tenant(orgA, (tx) => hasControlledCorrection(tx, orgA, medicineId));
    expect(await correction(medicine.opioid)).toBe(true);
    expect(await correction(medicine.hypnotic)).toBe(false);
    expect(await correction(medicine.sedative)).toBe(false);
    // Tenant-scoped: another organization cannot read this tenant's correction.
    expect(await tenant(orgB, (tx) => hasControlledCorrection(tx, orgB, medicine.opioid))).toBe(
      false
    );

    const again = await stage();
    // Both rows naming the corrected opioid are skipped and counted; the others flag again.
    expect(again).toEqual({
      controlledRows: 4,
      medicineIds: [medicine.hypnotic, medicine.sedative].sort(),
      skippedCorrectedRows: 2,
    });
    expect(await controlled(orgA, medicine.opioid)).toBe(false);
    expect(await controlled(orgA, medicine.sedative)).toBe(true);
    expect(await controlled(orgA, medicine.hypnotic)).toBe(true);
  });

  it('keeps the correction when a proposal for that medicine is confirmed, and still flags a new one', async () => {
    await owner.query(
      `INSERT INTO pharmacy_migration_rows
        (id, "organizationId", "batchId", "sourceKey", "rowNumber", "rawPayload", "targetModelKey", "productName")
       VALUES ($1, $2, $3, 'row:3', 3, $4::jsonb, 'medicine', 'Synthetic Opioid 50mg')`,
      [id('row_opioid'), orgA, id('batch'), { Name: 'x', classname: 'NARCOTICS' }]
    );
    const opioid = await tenant(orgA, async (tx) => {
      const current = await tx.medicine.findFirstOrThrow({ where: { id: medicine.opioid } });
      return applyLegacyControlledToMedicine(tx, orgA, current);
    });
    expect(opioid).toBe(false);
    expect(await controlled(orgA, medicine.opioid)).toBe(false);

    const created = await tenant(orgA, async (tx) => {
      const fresh = await tx.medicine.create({
        data: { productName: 'Synthetic Tranquilliser 2mg', productFamily: 'PHARMACEUTICAL' },
      });
      return { id: fresh.id, set: await applyLegacyControlledToMedicine(tx, orgA, fresh) };
    });
    expect(created.set).toBe(true);
    expect(await controlled(orgA, created.id)).toBe(true);
  });
});
