/**
 * DEV-741 against migrated PostgreSQL with FORCED row level security.
 *
 * What only a real database can show: tenant isolation of bridges and jobs,
 * the one-original-per-sale partial unique index, the immutable-payload and
 * monotonic-attempt triggers, the "accepted is final" rule, no deletes, and
 * the queue rules working through real Prisma predicates. Skipped (never
 * silently passed) when the database URL is absent. The runtime role is
 * asserted NOSUPERUSER/NOBYPASSRLS first.
 *
 * No printer, network target or host bridge is involved: TRANSPORT_ACCEPTED
 * here is a simulated acknowledgement, not paper.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.AUTH_SECRET ??= randomBytes(32).toString('hex');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_dev741_a_${suffix}`;
const ORG_B = `org_dev741_b_${suffix}`;
const BRANCH_A = `branch_dev741_a_${suffix}`;
const BRANCH_B = `branch_dev741_b_${suffix}`;
const ACTOR = 'user_dev741';

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  queue: typeof import('./receipt-print-queue');
  renderEscPos: (typeof import('@/lib/restaurant/printing/esc-pos'))['renderEscPos'];
};
let deps: Deps;

const inOrg = <T>(organizationId: string, work: (db: ScopedDb) => Promise<T>) =>
  deps.withTenantDb(organizationId, work);

function refusal(organizationId: string, work: (db: ScopedDb) => Promise<unknown>) {
  return inOrg(organizationId, (db) =>
    work(db)
      .then(() => 'ACCEPTED — the statement was expected to fail')
      .catch((error: Error) => error.message)
  );
}

const document = {
  type: 'RECEIPT' as const,
  reference: 'receipt:7',
  title: 'Receipt 7',
  createdAt: '2026-11-04T10:00:00.000Z',
  lines: [{ quantity: 1, label: 'Panadol - 500 mg - Tablet' }],
};

let counter = 0;
async function saleWithBridge(organizationId: string, branchId: string) {
  counter += 1;
  return inOrg(organizationId, async (db) => {
    await db.pharmacyBranch.createMany({
      data: [
        {
          id: branchId,
          organizationId,
          code: branchId,
          name: `Branch ${branchId}`,
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      ],
      skipDuplicates: true,
    });
    const sale = await db.pharmacySale.create({
      data: { organizationId, branchId, createdByUserId: ACTOR },
    });
    const { bridge, credential } = await deps.queue.enrollPharmacyPrintBridge(
      db,
      { organizationId, branchId, actorId: 'user_admin' },
      { name: `Bridge ${counter}`, printerId: `queue:///Receipt_${counter}` }
    );
    await deps.queue.touchPharmacyPrintBridge(db, bridge, new Date());
    return { saleId: sale.id, bridge: { ...bridge, lastSeenAt: new Date() }, credential };
  });
}

async function enqueue(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  saleId: string,
  extra: { reprint?: boolean; requestKey?: string; now?: Date; bridgeId?: string } = {}
) {
  const copyNumber = extra.reprint ? (extra.requestKey === 'click-0002' ? 3 : 2) : 1;
  await db.$executeRaw`INSERT INTO pharmacy_receipt_print_dispatches
    (id, "organizationId", "branchId", "saleId", "copyNumber", "actorId", locale)
    VALUES (${randomUUID()}, ${organizationId}, ${branchId}, ${saleId}, ${copyNumber}, ${ACTOR}, 'en')
    ON CONFLICT ("organizationId", "branchId", "saleId", "copyNumber") DO NOTHING`;
  return deps.queue.enqueuePharmacyReceiptPrint(db, {
    copyNumber,
    organizationId,
    branchId,
    actorId: ACTOR,
    saleId,
    receiptNumber: 7,
    reprint: extra.reprint ?? false,
    requestKey: extra.requestKey,
    bridgeId: extra.bridgeId,
    document,
    byteCount: deps.renderEscPos(document).length,
    paperWidth: 80,
    now: extra.now ?? new Date(),
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, queue, escPos, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./receipt-print-queue'),
    import('@/lib/restaurant/printing/esc-pos'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, queue, renderEscPos: escPos.renderEscPos };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  await scopedDb.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    )
  );
}, 180_000);

describeIfDatabase('DEV-741 pharmacy receipt print queue (PostgreSQL)', () => {
  it('keeps bridges and jobs invisible to another tenant, including by credential hash', async () => {
    const a = await saleWithBridge(ORG_A, BRANCH_A);
    const job = await inOrg(ORG_A, (db) =>
      enqueue(db, ORG_A, BRANCH_A, a.saleId, { bridgeId: a.bridge.id })
    );
    const parsed = deps.queue.parsePharmacyPrintBridgeCredential(a.credential)!;
    const fromB = await inOrg(ORG_B, async (db) => ({
      bridges: await db.pharmacyPrintBridge.count({ where: { id: a.bridge.id } }),
      jobs: await db.pharmacyPrintJob.count({ where: { id: job.job.id } }),
      byHash: await deps.queue.resolvePharmacyPrintBridge(db, { ...parsed, organizationId: ORG_B }),
    }));
    expect(fromB).toEqual({ bridges: 0, jobs: 0, byHash: null });
    const fromA = await inOrg(ORG_A, (db) => deps.queue.resolvePharmacyPrintBridge(db, parsed));
    expect(fromA?.id).toBe(a.bridge.id);
  });

  it('allows one original per sale even under a different key, but any number of reprints', async () => {
    const a = await saleWithBridge(ORG_A, BRANCH_A);
    await inOrg(ORG_A, (db) => enqueue(db, ORG_A, BRANCH_A, a.saleId, { bridgeId: a.bridge.id }));
    const forged = await refusal(ORG_A, (db) =>
      db.pharmacyPrintJob.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          bridgeId: a.bridge.id,
          printerId: a.bridge.printerId,
          saleId: a.saleId,
          receiptNumber: 7,
          reprint: false,
          copyNumber: 1,
          idempotencyKey: `sale:${a.saleId}:original-again`,
          document,
          byteCount: 10,
          paperWidth: 80,
          requestedByActorId: ACTOR,
        },
      })
    );
    expect(forged).toMatch(/Unique constraint|unique/i);
    await inOrg(ORG_A, async (db) => {
      await enqueue(db, ORG_A, BRANCH_A, a.saleId, {
        reprint: true,
        requestKey: 'click-0001',
        bridgeId: a.bridge.id,
      });
      await enqueue(db, ORG_A, BRANCH_A, a.saleId, {
        reprint: true,
        requestKey: 'click-0002',
        bridgeId: a.bridge.id,
      });
      const replay = await enqueue(db, ORG_A, BRANCH_A, a.saleId, {
        reprint: true,
        requestKey: 'click-0002',
        bridgeId: a.bridge.id,
      });
      expect(replay.replayed).toBe(true);
      expect(await db.pharmacyPrintJob.count({ where: { saleId: a.saleId } })).toBe(3);
    });
  });

  it('refuses payload edits, attempt rewinds, re-opening accepted work, and deletes', async () => {
    const a = await saleWithBridge(ORG_A, BRANCH_A);
    const { job } = await inOrg(ORG_A, (db) =>
      enqueue(db, ORG_A, BRANCH_A, a.saleId, { bridgeId: a.bridge.id })
    );
    const where = { organizationId_id: { organizationId: ORG_A, id: job.id } };
    expect(
      await refusal(ORG_A, (db) =>
        db.pharmacyPrintJob.update({
          where,
          data: { document: { ...document, title: 'Receipt 8' } },
        })
      )
    ).toContain('PRINT_JOB_IMMUTABLE');
    expect(
      await refusal(ORG_A, (db) =>
        db.pharmacyPrintJob.update({ where, data: { printerId: 'tcp://192.0.2.99:9100' } })
      )
    ).toContain('PRINT_JOB_IMMUTABLE');

    const now = new Date();
    const claim = await inOrg(ORG_A, (db) =>
      deps.queue.claimNextPharmacyPrintJob(db, a.bridge, now)
    );
    expect(claim).toMatchObject({ id: job.id, attempt: 1, paperWidth: 80 });
    expect(
      await refusal(ORG_A, (db) => db.pharmacyPrintJob.update({ where, data: { attemptCount: 0 } }))
    ).toContain('PRINT_JOB_ATTEMPTS_MONOTONIC');

    const ack = await inOrg(ORG_A, (db) =>
      deps.queue.acknowledgePharmacyPrintJob(db, a.bridge, {
        jobId: job.id,
        claimToken: claim!.claimToken,
        outcome: 'TRANSPORT_ACCEPTED',
        now: new Date(now.getTime() + 1_000),
      })
    );
    expect(ack).toEqual({ acknowledged: true, replayed: false });
    expect(
      await refusal(ORG_A, (db) =>
        db.pharmacyPrintJob.update({
          where,
          data: { status: 'PENDING', acceptedAt: null, lastAttemptAt: null },
        })
      )
    ).toContain('PRINT_JOB_ALREADY_ACCEPTED');

    // No DELETE policy: the tenant connection matches zero rows.
    const deleted = await inOrg(ORG_A, (db) =>
      db.pharmacyPrintJob.deleteMany({ where: { id: job.id } })
    );
    expect(deleted.count).toBe(0);
    const view = await inOrg(ORG_A, async (db) =>
      deps.queue.printJobView(
        await deps.queue.readPharmacyPrintJob(
          db,
          { organizationId: ORG_A, branchId: BRANCH_A },
          job.id
        ),
        new Date()
      )
    );
    expect(view).toMatchObject({
      state: 'SENT_TO_PRINTER',
      paperConfirmed: false,
      attemptCount: 1,
    });
  });

  it('runs a failure, operator retry and second attempt through real predicates', async () => {
    const a = await saleWithBridge(ORG_A, BRANCH_A);
    const scope = { organizationId: ORG_A, branchId: BRANCH_A, actorId: 'user_cashier_2' };
    const { job } = await inOrg(ORG_A, (db) =>
      enqueue(db, ORG_A, BRANCH_A, a.saleId, { bridgeId: a.bridge.id })
    );
    const t1 = new Date();
    const first = (await inOrg(ORG_A, (db) =>
      deps.queue.claimNextPharmacyPrintJob(db, a.bridge, t1)
    ))!;
    await inOrg(ORG_A, (db) =>
      deps.queue.acknowledgePharmacyPrintJob(db, a.bridge, {
        jobId: job.id,
        claimToken: first.claimToken,
        outcome: 'FAILED',
        failureCode: 'TRANSPORT_FAILED',
        now: new Date(t1.getTime() + 500),
      })
    );
    await expect(
      inOrg(ORG_A, (db) =>
        deps.queue.retryPharmacyPrintJob(db, scope, {
          jobId: job.id,
          paperChecked: false,
          now: new Date(),
        })
      )
    ).rejects.toMatchObject({ reason: 'PAPER_CHECK_REQUIRED' });
    const retried = await inOrg(ORG_A, (db) =>
      deps.queue.retryPharmacyPrintJob(db, scope, {
        jobId: job.id,
        paperChecked: true,
        now: new Date(),
      })
    );
    expect(retried).toMatchObject({
      status: 'PENDING',
      attemptCount: 1,
      retriedByActorId: 'user_cashier_2',
    });
    const second = (await inOrg(ORG_A, (db) =>
      deps.queue.claimNextPharmacyPrintJob(db, a.bridge, new Date())
    ))!;
    expect(second.attempt).toBe(2);
    const stale = await inOrg(ORG_A, (db) =>
      deps.queue.acknowledgePharmacyPrintJob(db, a.bridge, {
        jobId: job.id,
        claimToken: first.claimToken,
        outcome: 'TRANSPORT_ACCEPTED',
        now: new Date(),
      })
    );
    expect(stale).toEqual({ acknowledged: false, replayed: false });
  });

  it('never offers a stale unclaimed job and refuses a revoked bridge for new work', async () => {
    const b = await saleWithBridge(ORG_B, BRANCH_B);
    const old = new Date(Date.now() - deps.queue.PRINT_QUEUE_TTL_MS - 1_000);
    await inOrg(ORG_B, (db) =>
      enqueue(db, ORG_B, BRANCH_B, b.saleId, { now: old, bridgeId: b.bridge.id })
    );
    expect(
      await inOrg(ORG_B, (db) => deps.queue.claimNextPharmacyPrintJob(db, b.bridge, new Date()))
    ).toBeNull();
    await inOrg(ORG_B, (db) =>
      deps.queue.revokePharmacyPrintBridge(
        db,
        { organizationId: ORG_B, branchId: BRANCH_B },
        b.bridge.id,
        new Date()
      )
    );
    expect(
      await refusal(ORG_B, (db) =>
        db.pharmacyPrintBridge.update({
          where: { organizationId_id: { organizationId: ORG_B, id: b.bridge.id } },
          data: { status: 'ACTIVE', revokedAt: null },
        })
      )
    ).toContain('PRINT_BRIDGE_REVOKED');
    await expect(
      inOrg(ORG_B, (db) =>
        enqueue(db, ORG_B, BRANCH_B, b.saleId, {
          reprint: true,
          requestKey: 'click-0009',
          bridgeId: b.bridge.id,
        })
      )
    ).rejects.toMatchObject({ reason: 'BRIDGE_NOT_FOUND' });
  });
});
