/**
 * @vitest-environment node
 *
 * CAM-2 counter evidence against a REAL migrated PostgreSQL: the evidence
 * request is written inside the money event's transaction, the platform worker
 * relays it into a pharmacy.camera.snapshot.v1 job, the simulated gateway's
 * still lands in private storage, and receipt history shows it on a refund.
 * Retention clears stills past the gateway period unless a FISCAL legal hold
 * protects them.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role. RLS is asserted here, so the suite first proves that
 * role is neither SUPERUSER nor BYPASSRLS. Without the URL it reports skipped.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
// Resolved when the camera runtime module is evaluated, in the dynamic imports.
process.env.CAMERA_GATEWAY_MODE = 'simulated';

// Integrated tip: the money paths now take the F3 day lock (pg_advisory_xact_lock), whose void
// result only the application client in '@/lib/db' decodes. Use that client, as production does,
// instead of a bare PrismaPg client (db.prisma-void.test.ts covers the same adapter behaviour).

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scope = { organizationId: string; branchId: string; actorId: string };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let processPlatformJobs: typeof import('@/lib/platform/jobs').processPlatformJobs;
let storage: typeof import('@/lib/storage');
let evidence: typeof import('./counter-evidence');
let sales: typeof import('./sales');
let ledger: typeof import('./stock-ledger');
let settlement: typeof import('./settlement');
let counter: typeof import('./counter');
let receiptView: typeof import('@/components/pharmacy/counter/counter-receipt-view');
let simulated: typeof import('@/lib/cameras/simulated-gateway');
let cameraEvidence: typeof import('@/lib/cameras/evidence');
let directory: string;

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const businessDate = new Date('2026-09-29T09:00:00.000Z');
const DAY_MS = 86_400_000;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  directory = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'counter-evidence-')
  );
  vi.stubEnv('AZURE_STORAGE_ACCOUNT_NAME', '');
  // Integrated tip: storage fails closed unless an adapter is named explicitly.
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  // storage.ts fixes its local root from cwd at import: point it at scratch.
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
  storage = await import('@/lib/storage');
  cwd.mockRestore();

  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  ({ processPlatformJobs } = await import('@/lib/platform/jobs'));
  evidence = await import('./counter-evidence');
  sales = await import('./sales');
  ledger = await import('./stock-ledger');
  settlement = await import('./settlement');
  counter = await import('./counter');
  receiptView = await import('@/components/pharmacy/counter/counter-receipt-view');
  simulated = await import('@/lib/cameras/simulated-gateway');
  cameraEvidence = await import('@/lib/cameras/evidence');

  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
  // Cold imports of the settlement and job graph exceed the default on a busy host.
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const tenant = <T>(scope: Scope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId });
const platform = <T>(work: (db: ScopedDb) => Promise<T>) => withPlatformDb(work);

/** One organization, one pharmacy branch with stock, and a counter camera. */
async function setupTenant(label: string, options: { camera?: boolean } = {}) {
  const organizationId = `cam2_${label}_${run}`;
  const scope: Scope = {
    organizationId,
    branchId: `cam2_branch_${label}_${run}`,
    actorId: `cam2-actor-${label}`,
  };
  await platform((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  const stock = await tenant(scope, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId,
        code: scope.branchId,
        name: `Evidence ${label}`,
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: 'Evidence medicine',
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        code: randomUUID(),
        name: 'Stock',
        kind: 'STORE',
      },
    });
    // Integrated tip (F13): a refund on a settled sale needs returned goods, held in quarantine.
    await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        code: randomUUID(),
        name: 'Returns quarantine',
        kind: 'QUARANTINE',
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `EV-${label}`,
        expiresAt: new Date('2031-01-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: location.id,
      unitsPerPack: 10,
      supplierName: 'Test',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 1,
      printedMrpMinor: 1000,
      receivedExpiresAt: new Date('2031-01-01T00:00:00.000Z'),
      receivedExpiryPrecision: 'DAY',
      quantityUnits: 500,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2026-01-01'),
    });
    return { medicineId: medicine.id, presentationId: presentation.id, packLevelId: pack.id };
  });
  const camera =
    options.camera === false
      ? null
      : await tenant(scope, async (db) => {
          const gateway = await db.cameraGateway.create({
            data: {
              organizationId,
              branchId: scope.branchId,
              name: 'Counter gateway',
              gatewaySecretHash: createHash('sha256').update(randomUUID()).digest('hex'),
              baseUrl: 'https://gateway.example.test/',
              retentionDays: 7,
            },
          });
          const credential = await db.cameraCredential.create({
            data: { organizationId, sealedValue: 'sealed-fixture' },
          });
          return db.camera.create({
            data: {
              organizationId,
              branchId: scope.branchId,
              gatewayId: gateway.id,
              credentialId: credential.id,
              name: 'Counter',
              sourceRef: 'sim-camera-1',
              counterEvidence: true,
            },
          });
        });

  /** A 950-minor sale of ten units, open for tendering. */
  async function openSale() {
    return tenant(scope, async (db) => {
      const sale = await sales.createSale(db, scope);
      await sales.addSaleLine(db, scope, {
        saleId: sale.id,
        medicineId: stock.medicineId,
        presentationId: stock.presentationId,
        packLevelId: stock.packLevelId,
        saleUnit: 'UNIT',
        quantity: 10,
        canonicalUnitsPerSaleUnit: 1,
        discountMinor: 50,
        discountKind: 'DISCOUNT',
        approvedByUserId: scope.actorId,
        approvalPolicy: 'test',
        idempotencyKey: randomUUID(),
      });
      return sale.id;
    });
  }

  /** Exactly what the tender mutation does: the tender and its evidence in one transaction. */
  async function tender(saleId: string, amountMinor = 950) {
    const input = {
      saleId,
      deviceId: `device-${label}`,
      businessDate,
      type: 'BANK_TRANSFER' as const,
      amountMinor,
      idempotencyKey: randomUUID(),
    };
    return tenant(scope, async (db) => {
      const result = await settlement.applyPharmacyTender(db, scope, input);
      const tenderId = evidence.settledSubjectId(result, 'tenderId');
      const requested = await evidence.requestCounterEvidence(db, scope, {
        kind: 'TENDER',
        subjectId: tenderId,
      });
      return { ...result, input, tenderId, evidenceId: requested?.evidenceId ?? null };
    });
  }

  async function refund(tenderId: string, amountMinor = 100) {
    return tenant(scope, async (db) => {
      const result = await settlement.refundPharmacyTender(db, scope, {
        originalTenderId: tenderId,
        deviceId: `device-${label}`,
        businessDate,
        amountMinor,
        reason: 'Customer returned the strip',
        idempotencyKey: randomUUID(),
      });
      const refundId = evidence.settledSubjectId(result, 'refundId');
      const requested = await evidence.requestCounterEvidence(db, scope, {
        kind: 'REFUND',
        subjectId: refundId,
      });
      return { ...result, refundId, evidenceId: requested?.evidenceId ?? null };
    });
  }

  async function capture(evidenceId: string, now = new Date()) {
    return platform((db) =>
      evidence.runCounterEvidenceSnapshotJob(
        db,
        { organizationId, type: 'PHARMACY_CAMERA_SNAPSHOT_V1', attempts: 1, maxAttempts: 3 },
        { evidenceId },
        { now }
      )
    );
  }

  async function retention(now: Date) {
    return platform((db) =>
      evidence.runCameraEvidenceRetentionJob(
        db,
        { organizationId, type: 'CAMERA_EVIDENCE_RETENTION_V1' },
        { now }
      )
    );
  }

  const row = (id: string) =>
    tenant(scope, (db) => db.cameraEvidence.findUniqueOrThrow({ where: { id } }));

  /**
   * Integrated tip (F13): every refund on a settled sale is capped at the value of goods returned,
   * so the refund cases first return units (unidentified, to quarantine) worth at least the refund.
   */
  async function returnUnits(saleId: string, canonicalUnits = 2) {
    return tenant(scope, async (db) => {
      const line = await db.pharmacySaleLine.findFirstOrThrow({
        where: { saleId, organizationId: scope.organizationId, branchId: scope.branchId },
        select: { id: true },
      });
      return sales.returnSaleLine(db, scope, {
        saleLineId: line.id,
        canonicalUnits,
        reason: 'Customer returned the strip',
        integrityDecision: 'Sealed strip, lot not verified',
        idempotencyKey: randomUUID(),
      });
    });
  }

  return { scope, camera, openSale, tender, returnUnits, refund, capture, retention, row };
}

async function uploadCount(organizationId: string) {
  try {
    return (await readdir(join(directory, 'private-uploads', organizationId))).length;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 0;
    throw error;
  }
}

const PNG_DATA_URL = /^data:image\/png;base64,iVBORw0KGgo/;

/**
 * A committed daily close row. `cutPharmacyDailyClose` itself cannot run on this
 * stack at the CAM-2 base: its `$queryRaw` of pg_advisory_xact_lock returns a
 * void column the Prisma 7 adapter refuses to deserialize (reported on WHA-1612,
 * outside this lane). The binding under test only needs the close to exist.
 */
function recordClose(db: ScopedDb, scope: Scope) {
  return db.pharmacyDailyClose.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate,
      sequence: 1,
      grossSalesMinor: 950,
      refundTotalMinor: 0,
      netSalesMinor: 950,
      cashExpectedMinor: 0,
      cashCountedMinor: 0,
      cashVarianceMinor: 0,
      sourceHash: `close-${randomUUID()}`,
      actorId: scope.actorId,
    },
  });
}

describeDatabase('CAM-2 counter evidence on migrated PostgreSQL', () => {
  it('stores a simulated-gateway still for a refund and shows it in receipt history', async () => {
    const t = await setupTenant('refund');
    const saleId = await t.openSale();
    const tendered = await t.tender(saleId);
    await t.returnUnits(saleId);
    const refunded = await t.refund(tendered.tenderId);
    expect(tendered.evidenceId).toEqual(expect.any(String));
    expect(refunded.evidenceId).toEqual(expect.any(String));
    expect((await t.row(refunded.evidenceId!)).status).toBe('PENDING');

    const firstPass = await processPlatformJobs(50);
    expect(firstPass.failed).toBe(0);
    expect(firstPass.retried).toBe(0);

    const jobs = await platform((db) =>
      db.$queryRawUnsafe<Array<{ type: string; status: string; key: string }>>(
        `SELECT type::text AS type, status::text AS status, "idempotencyKey" AS key
           FROM platform_jobs WHERE "organizationId" = $1 AND type::text = 'pharmacy.camera.snapshot.v1'
          ORDER BY key`,
        t.scope.organizationId
      )
    );
    expect(jobs).toEqual(
      [tendered.evidenceId!, refunded.evidenceId!].sort().map((id) => ({
        type: 'pharmacy.camera.snapshot.v1',
        status: 'SUCCEEDED',
        key: `pharmacy.camera.snapshot.v1:${id}`,
      }))
    );

    const refundRow = await t.row(refunded.evidenceId!);
    expect(refundRow).toMatchObject({
      status: 'CAPTURED',
      subjectKind: 'PHARMACY_REFUND',
      subjectId: refunded.refundId,
      saleId,
      byteLength: expect.any(Number),
    });
    expect(refundRow.storageKey).toMatch(/^camera-snapshot-[a-f0-9-]+\.png$/);
    const stored = await storage.getUpload(t.scope.organizationId, refundRow.storageKey!);
    expect(Array.from(stored.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    // A second worker pass queues nothing new for settled evidence.
    await processPlatformJobs(50);
    const snapshotJobs = await platform((db) =>
      db.platformJob.count({
        where: { organizationId: t.scope.organizationId, type: 'PHARMACY_CAMERA_SNAPSHOT_V1' },
      })
    );
    expect(snapshotJobs).toBe(2);
    // Fresh stills are not due, so no retention pass is queued for them.
    const retentionJobs = await platform((db) =>
      db.platformJob.count({
        where: { organizationId: t.scope.organizationId, type: 'CAMERA_EVIDENCE_RETENTION_V1' },
      })
    );
    expect(retentionJobs).toBe(0);

    const history = await tenant(t.scope, (db) =>
      evidence.readCounterEvidence(db, t.scope, saleId)
    );
    expect(history.map((item) => [item.kind, item.status])).toEqual([
      ['TENDER', 'CAPTURED'],
      ['REFUND', 'CAPTURED'],
    ]);
    expect(history[1]!.image).toMatch(PNG_DATA_URL);
    expect(JSON.stringify(history)).not.toContain(refundRow.storageKey!);

    const receipt = await tenant(t.scope, (db) =>
      counter.readCounterReceipt(db, t.scope, saleId, { name: 'Evidence refund', currency: 'PKR' })
    );
    const html = renderToStaticMarkup(
      createElement(receiptView.CounterReceiptView, {
        receipt,
        state: 'ready',
        locale: 'en',
        format: 'THERMAL',
        reprint: true,
        onLocaleChange: () => undefined,
        onFormatChange: () => undefined,
        onPrint: async () => false,
        onRetry: () => undefined,
        evidence: history,
      })
    );
    expect(html).toContain('aria-label="Camera evidence"');
    expect(html).toMatch(
      /<img src="data:image\/png;base64,iVBORw0KGgo[^"]*" alt="Camera still at refund, /
    );
  });

  it('binds nothing when the money event rolls back, and never blocks a branch without a camera', async () => {
    const t = await setupTenant('rollback');
    const saleId = await t.openSale();
    const tendered = await t.tender(saleId);
    await t.returnUnits(saleId);
    const failure = new Error('refund aborted after evidence request');
    await expect(
      tenant(t.scope, async (db) => {
        const result = await settlement.refundPharmacyTender(db, t.scope, {
          originalTenderId: tendered.tenderId,
          deviceId: 'device-rollback',
          businessDate,
          amountMinor: 100,
          reason: 'Rolled back',
          idempotencyKey: randomUUID(),
        });
        await evidence.requestCounterEvidence(db, t.scope, {
          kind: 'REFUND',
          subjectId: evidence.settledSubjectId(result, 'refundId'),
        });
        throw failure;
      })
    ).rejects.toBe(failure);
    const refunds = await tenant(t.scope, (db) =>
      db.cameraEvidence.count({ where: { saleId, subjectKind: 'PHARMACY_REFUND' } })
    );
    expect(refunds).toBe(0);

    const bare = await setupTenant('nocamera', { camera: false });
    const bareSale = await bare.openSale();
    const bareTender = await bare.tender(bareSale);
    expect(bareTender).toMatchObject({ settled: true, evidenceId: null });

    const close = await tenant(bare.scope, async (db) => {
      const cut = await recordClose(db, bare.scope);
      return evidence.requestCounterEvidence(db, bare.scope, {
        kind: 'DAILY_CLOSE',
        subjectId: cut.id,
      });
    });
    expect(close).toBeNull();

    // Integrated tip: the subject is validated before the camera lookup (counter-evidence
    // private test "refuses another branch's tender before looking for a camera"), so a foreign
    // subject is refused even in a branch without a camera. F6 treated it as a silent no-op.
    await expect(
      tenant(bare.scope, (db) =>
        evidence.requestCounterEvidence(db, bare.scope, {
          kind: 'TENDER',
          subjectId: tendered.tenderId,
        })
      )
    ).rejects.toThrow('NOT_FOUND');

    // With a camera, a subject outside this tenant is refused, not silently bound.
    await expect(
      tenant(t.scope, (db) =>
        evidence.requestCounterEvidence(db, t.scope, {
          kind: 'TENDER',
          subjectId: bareTender.tenderId,
        })
      )
    ).rejects.toThrow('NOT_FOUND');
  });

  it('binds one still per event under replay and concurrency, and a raced capture keeps one file', async () => {
    const t = await setupTenant('race');
    const saleId = await t.openSale();
    const tendered = await t.tender(saleId);
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        tenant(t.scope, (db) =>
          evidence.requestCounterEvidence(db, t.scope, {
            kind: 'TENDER',
            subjectId: tendered.tenderId,
          })
        )
      )
    );
    expect(new Set(concurrent.map((value) => value?.evidenceId))).toEqual(
      new Set([tendered.evidenceId])
    );
    const replay = await tenant(t.scope, async (db) => {
      const result = await settlement.applyPharmacyTender(db, t.scope, tendered.input);
      expect(result.replayed).toBe(true);
      return evidence.requestCounterEvidence(db, t.scope, {
        kind: 'TENDER',
        subjectId: evidence.settledSubjectId(result, 'tenderId'),
      });
    });
    expect(replay?.evidenceId).toBe(tendered.evidenceId);

    // The daily close binds too, with no sale.
    const close = await tenant(t.scope, async (db) => {
      const cut = await recordClose(db, t.scope);
      return evidence.requestCounterEvidence(db, t.scope, {
        kind: 'DAILY_CLOSE',
        subjectId: cut.id,
      });
    });
    expect(await t.row(close!.evidenceId)).toMatchObject({
      subjectKind: 'PHARMACY_DAILY_CLOSE',
      saleId: null,
      status: 'PENDING',
    });

    const before = await uploadCount(t.scope.organizationId);
    const outcomes = await Promise.all([
      t.capture(tendered.evidenceId!),
      t.capture(tendered.evidenceId!),
    ]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
      'ALREADY_SETTLED',
      'CAPTURED',
    ]);
    expect(await uploadCount(t.scope.organizationId)).toBe(before + 1);
    expect((await t.row(tendered.evidenceId!)).status).toBe('CAPTURED');
  });

  it('keeps evidence tenant- and branch-isolated under forced RLS', async () => {
    const a = await setupTenant('rlsa');
    const b = await setupTenant('rlsb', { camera: false });
    const saleId = await a.openSale();
    const tendered = await a.tender(saleId);

    const forced = await platform((db) =>
      db.$queryRawUnsafe<Array<{ relname: string; enabled: boolean; forced: boolean }>>(
        `SELECT relname::text AS relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class
          WHERE relname IN ('camera_gateways','camera_credentials','cameras','camera_stream_grants','camera_evidence')
          ORDER BY relname`
      )
    );
    expect(forced).toHaveLength(5);
    expect(forced.every((table) => table.enabled && table.forced)).toBe(true);

    expect(
      await tenant(b.scope, (db) =>
        db.cameraEvidence.count({ where: { id: tendered.evidenceId! } })
      )
    ).toBe(0);
    expect(
      await tenant(b.scope, (db) => evidence.readCounterEvidence(db, b.scope, saleId))
    ).toEqual([]);
    const otherBranch = { ...a.scope, branchId: b.scope.branchId };
    expect(
      await tenant(a.scope, (db) => evidence.readCounterEvidence(db, otherBranch, saleId))
    ).toEqual([]);

    await expect(
      tenant(b.scope, (db) =>
        db.cameraEvidence.create({
          data: {
            organizationId: a.scope.organizationId,
            branchId: a.scope.branchId,
            subjectKind: 'PHARMACY_TENDER',
            subjectId: `forged-${run}`,
            saleId,
            cameraId: a.camera!.id,
          },
        })
      )
    ).rejects.toThrow();
  });

  it('keeps the binding immutable and moves a still only forward', async () => {
    const t = await setupTenant('guard');
    const saleId = await t.openSale();
    const tendered = await t.tender(saleId);
    const id = tendered.evidenceId!;

    await expect(
      tenant(t.scope, (db) =>
        db.cameraEvidence.update({ where: { id }, data: { subjectId: 'another-tender' } })
      )
    ).rejects.toThrow(/binding is immutable/);
    await expect(
      tenant(t.scope, (db) => db.cameraEvidence.delete({ where: { id } }))
    ).rejects.toThrow(/retained/);
    await expect(
      tenant(t.scope, (db) =>
        db.cameraEvidence.update({
          where: { id },
          data: { status: 'CAPTURED', storageKey: 'forged.png', byteLength: 1 },
        })
      )
    ).rejects.toThrow(/camera_evidence_state_check/);

    expect((await t.capture(id)).outcome).toBe('CAPTURED');
    await expect(
      tenant(t.scope, (db) =>
        db.cameraEvidence.update({
          where: { id },
          data: { status: 'PENDING', storageKey: null, capturedAt: null, byteLength: null },
        })
      )
    ).rejects.toThrow(/cannot move from CAPTURED to PENDING/);
  });

  it('purges stills past the gateway retention period but never under a legal hold', async () => {
    const t = await setupTenant('retention');
    const heldSale = await t.openSale();
    const freeSale = await t.openSale();
    const held = await t.tender(heldSale);
    const free = await t.tender(freeSale);
    const capturedAt = new Date();
    for (const id of [held.evidenceId!, free.evidenceId!]) {
      expect((await t.capture(id, capturedAt)).outcome).toBe('CAPTURED');
    }
    const heldKey = (await t.row(held.evidenceId!)).storageKey!;
    const freeKey = (await t.row(free.evidenceId!)).storageKey!;

    await tenant(t.scope, (db) =>
      db.pharmacyLegalHoldEvent.create({
        data: {
          id: randomUUID(),
          organizationId: t.scope.organizationId,
          holdKey: `inquiry-${run}`,
          recordClass: 'FISCAL',
          recordId: heldSale,
          kind: 'PLACED',
          reason: 'Inspector inquiry',
          actorUserId: t.scope.actorId,
        },
      })
    );

    // Inside the gateway's seven days: nothing is due.
    const early = await t.retention(new Date(capturedAt.getTime() + 6 * DAY_MS));
    expect(early.purgedIds).toEqual([]);

    // The gateway decides the period: at thirty days, day eight is not due either.
    await tenant(t.scope, (db) => db.cameraGateway.updateMany({ data: { retentionDays: 30 } }));
    expect((await t.retention(new Date(capturedAt.getTime() + 8 * DAY_MS))).purgedIds).toEqual([]);
    await tenant(t.scope, (db) => db.cameraGateway.updateMany({ data: { retentionDays: 7 } }));

    const due = await t.retention(new Date(capturedAt.getTime() + 8 * DAY_MS));
    expect(due.purgedIds).toEqual([free.evidenceId]);
    expect(due.held).toEqual([{ id: held.evidenceId, holdKeys: [`inquiry-${run}`] }]);
    expect(await t.row(free.evidenceId!)).toMatchObject({
      status: 'PURGED',
      storageKey: null,
      purgedAt: expect.any(Date),
    });
    await expect(storage.getUpload(t.scope.organizationId, freeKey)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await t.row(held.evidenceId!)).status).toBe('CAPTURED');
    expect(await storage.getUpload(t.scope.organizationId, heldKey)).toBeInstanceOf(Buffer);
    const shown = await tenant(t.scope, (db) =>
      evidence.readCounterEvidence(db, t.scope, freeSale)
    );
    expect(shown).toEqual([expect.objectContaining({ status: 'PURGED', image: null })]);

    // Releasing the hold lets the next pass clear it.
    await tenant(t.scope, (db) =>
      db.pharmacyLegalHoldEvent.create({
        data: {
          id: randomUUID(),
          organizationId: t.scope.organizationId,
          holdKey: `inquiry-${run}`,
          recordClass: 'FISCAL',
          recordId: heldSale,
          kind: 'RELEASED',
          reason: 'Inquiry closed',
          actorUserId: t.scope.actorId,
          createdAt: new Date(Date.now() + 1_000),
        },
      })
    );
    const released = await t.retention(new Date(capturedAt.getTime() + 8 * DAY_MS));
    expect(released.purgedIds).toEqual([held.evidenceId]);
    await expect(storage.getUpload(t.scope.organizationId, heldKey)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('steps over held stills so a capped pass still purges what is due', async () => {
    const t = await setupTenant('keyset');
    const sales = [await t.openSale(), await t.openSale(), await t.openSale()];
    const tenders = [];
    for (const saleId of sales) tenders.push(await t.tender(saleId));
    const base = Date.now();
    // Oldest first, so the held still leads the scan order.
    for (const [index, tendered] of tenders.entries()) {
      await t.capture(tendered.evidenceId!, new Date(base + index * 1_000));
    }
    await tenant(t.scope, (db) =>
      db.pharmacyLegalHoldEvent.create({
        data: {
          id: randomUUID(),
          organizationId: t.scope.organizationId,
          holdKey: `keyset-${run}`,
          recordClass: 'FISCAL',
          recordId: sales[0]!,
          kind: 'PLACED',
          reason: 'Held',
          actorUserId: t.scope.actorId,
        },
      })
    );
    const pass = () =>
      platform(async (db) => {
        await cameraEvidence.enterCameraTenantScope(db, t.scope.organizationId);
        return cameraEvidence.purgeExpiredCameraEvidence(db, {
          organizationId: t.scope.organizationId,
          now: new Date(base + 9 * DAY_MS),
          maxPurges: 1,
          heldBy: async (row) => (row.saleId === sales[0] ? [`keyset-${run}`] : []),
        });
      });
    const first = await pass();
    expect(first.purgedIds).toEqual([tenders[1]!.evidenceId]);
    expect(first.held.map((row) => row.id)).toEqual([tenders[0]!.evidenceId]);
    const second = await pass();
    expect(second.purgedIds).toEqual([tenders[2]!.evidenceId]);
    expect((await pass()).purgedIds).toEqual([]);
    expect((await t.row(tenders[0]!.evidenceId!)).status).toBe('CAPTURED');
  });

  it('fails closed: gateway errors retry then fail, unsupported gateways and late captures never store', async () => {
    const t = await setupTenant('failures');
    const saleId = await t.openSale();
    const flaky = await t.tender(saleId, 100);
    const unsupported = await t.tender(saleId, 100);
    const late = await t.tender(saleId, 100);
    const before = await uploadCount(t.scope.organizationId);
    const down = {
      available: true as const,
      mode: 'simulated' as const,
      adapter: {
        ...simulated.createSimulatedCameraGateway(),
        getSnapshot: async () => {
          throw new Error('gateway 10.0.0.9 refused rtsp://user:secret@cam');
        },
      },
    };
    const attempt = (attempts: number) =>
      platform((db) =>
        evidence.runCounterEvidenceSnapshotJob(
          db,
          {
            organizationId: t.scope.organizationId,
            type: 'PHARMACY_CAMERA_SNAPSHOT_V1',
            attempts,
            maxAttempts: 3,
          },
          { evidenceId: flaky.evidenceId },
          { runtime: down }
        )
      );
    await expect(attempt(1)).rejects.toThrow('gateway 10.0.0.9');
    expect((await t.row(flaky.evidenceId!)).status).toBe('PENDING');
    expect(await attempt(3)).toMatchObject({ outcome: 'FAILED', reason: 'SNAPSHOT_UNAVAILABLE' });
    const failedRow = await t.row(flaky.evidenceId!);
    expect(failedRow).toMatchObject({ status: 'FAILED', failureReason: 'SNAPSHOT_UNAVAILABLE' });
    expect(JSON.stringify(failedRow)).not.toContain('secret');

    const unavailable = await platform((db) =>
      evidence.runCounterEvidenceSnapshotJob(
        db,
        {
          organizationId: t.scope.organizationId,
          type: 'PHARMACY_CAMERA_SNAPSHOT_V1',
          attempts: 1,
          maxAttempts: 3,
        },
        { evidenceId: unsupported.evidenceId },
        { runtime: { available: false, mode: 'unavailable', adapter: null } }
      )
    );
    expect(unavailable).toMatchObject({ outcome: 'FAILED', reason: 'SNAPSHOT_UNSUPPORTED' });

    const lateRow = await t.row(late.evidenceId!);
    const tooLate = await t.capture(
      late.evidenceId!,
      new Date(lateRow.requestedAt.getTime() + 16 * 60_000)
    );
    expect(tooLate).toMatchObject({ outcome: 'FAILED', reason: 'CAPTURE_WINDOW_ELAPSED' });

    expect(await uploadCount(t.scope.organizationId)).toBe(before);
  });
});
