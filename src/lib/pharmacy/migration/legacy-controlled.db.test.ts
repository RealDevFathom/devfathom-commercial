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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';
import { decideCatalogueEdit, submitCatalogueEdit } from '../catalogue-approvals';
import {
  applyLegacyControlledClass,
  applyLegacyControlledToMedicine,
  applyLegacyControlledToMedicines,
  hasControlledCorrection,
  hasStagedLegacyControlledRow,
} from './legacy-controlled';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const suite = runtimeUrl && ownerUrl ? describe : describe.skip;
// The router path (solo-owner PIN approval) opens its own tenant transactions on DATABASE_URL.
if (runtimeUrl && ownerUrl) process.env.DATABASE_URL = runtimeUrl;
// Only the automatic request log is suppressed; the approval audit is written for real.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = (label: string) => `lc_${label}_${suffix}`;
const orgA = id('org_a');
const orgB = id('org_b');
const orgSolo = id('org_solo');
const soloOwnerId = id('solo_owner');
const soloOpioid = id('med_solo_opioid');
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
    decision: 'APPROVE' | 'REJECT' = 'APPROVE'
  ) => {
    const proposal = await tenant(orgA, (tx) =>
      submitCatalogueEdit(tx, { organizationId: orgA, actorId: editorId }, medicineId, changes)
    );
    await tenant(orgA, (tx) =>
      decideCatalogueEdit(
        joined(tx),
        { organizationId: orgA, actorId: reviewerId, actorOrganizationId: orgA },
        { editId: proposal.id, decision }
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
    // The staged migration tables admit no platform-admin bypass: their fixture rows (all in
    // tenant A) are written in that tenant's context.
    await owner.query(`SELECT set_config('app.current_organization_id', $1, false)`, [orgA]);
    for (const organizationId of [orgA, orgB])
      await owner.query(
        // DEV-961: these approvals use PINs, which apply while the authenticator for approvals is off.
        `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "updatedAt", "requireApprovalAuthenticator")
         VALUES ($1, $1, 'Legacy class fixture', 'Legacy class fixture', 'ACTIVE', now(), false)`,
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
    // with no DEV-925 audit mark, and a correction a later approved edit reversed.
    await edit(medicine.hypnotic, { brandName: 'Synthetic brand' });
    await edit(medicine.hypnotic, { controlled: false }, 'REJECT');
    await edit(medicine.sedative, { controlled: false });
    await edit(medicine.sedative, { controlled: true });
    // An approval recorded before DEV-925 (before DEV-19 any admin could approve) has no mark.
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
  it('DEV-912: applies the same rule to a whole chunk of medicines in one statement', async () => {
    const result = await tenant(orgA, async (tx) => {
      const make = (productName: string) =>
        tx.medicine.create({ data: { productName, productFamily: 'PHARMACEUTICAL' } });
      // Re-spaced and re-cased: the same name key as the staged NARCOTICS row.
      const fresh = await make(' synthetic  tranquilliser 2MG');
      const plain = await make('Synthetic Antacid');
      const corrected = await tx.medicine.findFirstOrThrow({ where: { id: medicine.opioid } });
      const ids = await applyLegacyControlledToMedicines(tx, orgA, [
        corrected,
        fresh,
        plain,
        // Another tenant's medicine of a NARCOTICS name is never reached from this tenant.
        { id: medicine.otherTenant, productName: 'Synthetic Opioid 50mg', controlled: false },
      ]);
      return { ids, fresh: fresh.id, plain: plain.id };
    });
    expect(result.ids).toEqual([result.fresh]);
    expect(await controlled(orgA, result.fresh)).toBe(true);
    expect(await controlled(orgA, result.plain)).toBe(false);
    // The person's correction to "not controlled" (DEV-925) is kept.
    expect(await controlled(orgA, medicine.opioid)).toBe(false);
    expect(await controlled(orgB, medicine.otherTenant)).toBe(false);
    expect(await tenant(orgA, (tx) => applyLegacyControlledToMedicines(tx, orgA, []))).toEqual([]);
  });

  it("remembers a solo owner's PIN-approved correction when the file is staged again", async () => {
    const { pharmacyMedicineRouter } = await import('@/server/routers/pharmacy-medicine');
    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    // An owner-only pharmacy: nobody else can review, so the owner approves with a fresh PIN.
    await owner.query(
      // DEV-961: these approvals use PINs, which apply while the authenticator for approvals is off.
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "updatedAt", "requireApprovalAuthenticator")
       VALUES ($1, $1, 'Legacy class fixture', 'Legacy class fixture', 'ACTIVE', now(), false)`,
      [orgSolo]
    );
    await owner.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'Pharmacy', 'Pharmacy', now())`,
      [id('solo_department'), orgSolo]
    );
    await owner.query(
      `INSERT INTO organization_roles (id, "organizationId", key, name, "isSystem", "updatedAt")
       VALUES ($1, $2, 'owner', 'Owner', true, now())`,
      [id('solo_owner_role'), orgSolo]
    );
    await owner.query(
      `INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect)
       VALUES ($1, $2, $3, '*', 'ALLOW')`,
      [id('solo_owner_perm'), orgSolo, id('solo_owner_role')]
    );
    await owner.query(
      `INSERT INTO users (id, "organizationId", "organizationRoleId", name, email, department, title, role, "updatedAt")
       VALUES ($1, $2, $3, 'Owner', $4, 'Pharmacy', 'Owner', 'ADMIN', now())`,
      [soloOwnerId, orgSolo, id('solo_owner_role'), `${soloOwnerId}@legacy-class.test`]
    );
    await owner.query(
      `INSERT INTO restaurant_staff_profiles (id, "organizationId", "userId", "displayName", status, "updatedAt")
       VALUES ($1, $2, $3, 'Owner', 'ACTIVE', now())`,
      [id('solo_staff'), orgSolo, soloOwnerId]
    );
    await owner.query(
      `INSERT INTO restaurant_operator_credentials (id, "organizationId", "staffProfileId", type, "credentialHash", "updatedAt")
       VALUES ($1, $2, $3, 'PIN', $4, now())`,
      [id('solo_pin'), orgSolo, id('solo_staff'), await hashOperatorCredential('PIN', '2468')]
    );
    await owner.query(
      `INSERT INTO pharmacy_medicines (id, "organizationId", "productName", "productFamily", "updatedAt")
       VALUES ($1, $2, 'Synthetic Opioid 50mg', 'PHARMACEUTICAL', now())`,
      [soloOpioid, orgSolo]
    );
    const stageSolo = () =>
      tenant(orgSolo, (tx) => applyLegacyControlledClass(tx, orgSolo, legacyRows));
    expect((await stageSolo()).medicineIds).toEqual([soloOpioid]);
    expect(await controlled(orgSolo, soloOpioid)).toBe(true);

    const soloOwner = pharmacyMedicineRouter.createCaller({
      db: createTenantDb(orgSolo, soloOwnerId),
      entitlements: {
        organizationId: orgSolo,
        enabledModules: ['pharmacy-core'],
        activeSeats: 1,
        seatLimit: 10,
        modules: [],
        limits: {},
      },
      session: {
        expires: 'later',
        user: { id: soloOwnerId, organizationId: orgSolo, role: 'ADMIN', status: 'ACTIVE' },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext);
    const correction = await soloOwner.proposeCatalogueEdit({
      medicineId: soloOpioid,
      changes: { controlled: false },
    });
    // Without the fresh PIN the owner cannot approve their own correction.
    await expect(
      soloOwner.decideCatalogueEdit({ editId: correction.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await soloOwner.decideCatalogueEdit({
      editId: correction.id,
      decision: 'APPROVE',
      soloPin: '2468',
    });
    expect(await controlled(orgSolo, soloOpioid)).toBe(false);
    const audit = await tenant(orgSolo, (tx) =>
      tx.auditLog.findMany({
        where: { targetType: 'PharmacyCatalogueEdit', targetId: correction.id },
      })
    );
    expect(audit.map((row) => [row.action, row.metadata])).toEqual([
      [
        'pharmacy.catalogueSoloOwnerApproval',
        {
          soloOwner: true,
          pinVerified: true,
          reason: 'no other reviewer',
          controlledReviewed: true,
        },
      ],
    ]);

    // The same file staged again: the medicine stays not controlled and both rows are counted.
    expect(await stageSolo()).toEqual({
      controlledRows: 4,
      medicineIds: [],
      skippedCorrectedRows: 2,
    });
    expect(await controlled(orgSolo, soloOpioid)).toBe(false);
  });
});
