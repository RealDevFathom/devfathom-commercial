/**
 * PUR-06 — purchase returns, expiry claims, debit notes and supplier credit
 * against migrated PostgreSQL with FORCED row level security.
 *
 * These are the cases that only mean something against a real database. "A
 * claimed quantity cannot be sold" is the INV-09 reservation being subtracted
 * inside `allocateForSale`'s own SQL; "a claimed quantity cannot be
 * double-claimed" is that same subtraction under a row lock; "movements are
 * append-only" is a trigger; and RETURN_TO_SUPPLIER only holds stock out of
 * circulation if the projection actually moves it there. A mocked client would
 * assert that the code calls Prisma, not that any of those hold. Skipped (never
 * silently passed) when the database URL is absent.
 *
 * The runtime role is asserted NOSUPERUSER/NOBYPASSRLS first: with either
 * attribute the tenant case would read straight through every policy and pass
 * for the wrong reason.
 *
 * EVERY TEST GETS ITS OWN MEDICINE (`scenario()`), for the same reason as the
 * INV-01..04 suite: allocation candidates are looked up by medicine, so tests
 * sharing one would draw on each other's stock and a refusal case could pass by
 * borrowing a neighbour's lot. An expected database error also gets its own
 * transaction, because a failed statement aborts the whole PostgreSQL one.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1176_ret_a_${suffix}`;
const ORG_B = `org_wha1176_ret_b_${suffix}`;
const BRANCH_A = 'branch_a';
const CLERK = 'user_store_clerk';
const CONTROLLER = 'user_finance_controller';

/** Fixed instants, so no case depends on the wall clock. */
const NOW = new Date('2026-09-02T09:00:00.000Z');
const WINDOW_OPEN = new Date('2026-10-15T00:00:00.000Z');
const EXPIRES = new Date('2026-11-01T00:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  ledger: typeof import('./stock-ledger');
  returns: typeof import('./supplier-returns-operations');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

async function ensureBranch(db: ScopedDb, organizationId: string, branchId: string) {
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
}

type Scenario = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  packLevelId: string;
  locationId: string;
  supplierId: string;
};

async function scenario(organizationId: string, label: string): Promise<Scenario> {
  const branchId = `${BRANCH_A}_${organizationId}_${suffix}`;
  return inOrg(organizationId, async (db) => {
    await ensureBranch(db, organizationId, branchId);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Amoxicillin 250mg ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId, presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const [location, supplier] = await Promise.all([
      db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId,
          code: `MAIN-${tag(label)}`,
          name: 'Main store',
          kind: 'STORE',
        },
      }),
      db.pharmacySupplier.create({
        data: { organizationId, name: `Distributor ${tag(label)}`, authorized: true },
      }),
    ]);
    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      packLevelId: packLevel.id,
      locationId: location.id,
      supplierId: supplier.id,
    };
  });
}

function scopeOf(fixture: Scenario, actorId = CLERK) {
  return { organizationId: fixture.organizationId, branchId: fixture.branchId, actorId };
}

/** One manufacturing batch plus a received lot holding `units`, 10 per strip. */
async function stockLot(db: ScopedDb, fixture: Scenario, units: number, label: string) {
  const batch = await db.pharmacyManufacturingBatch.create({
    data: {
      organizationId: fixture.organizationId,
      medicineId: fixture.medicineId,
      batchNumber: `B-${tag(label)}`,
      expiresAt: EXPIRES,
      expiryPrecision: 'DAY',
    },
  });
  const { lot } = await deps.ledger.receiveLot(db, scopeOf(fixture), {
    manufacturingBatchId: batch.id,
    packLevelId: fixture.packLevelId,
    stockLocationId: fixture.locationId,
    unitsPerPack: 10,
    supplierName: 'Distributor Ltd',
    supplierInvoiceRef: `INV-${tag(label)}`,
    unitCostMinor: 1200,
    printedMrpMinor: 2000,
    receivedExpiresAt: EXPIRES,
    receivedExpiryPrecision: 'DAY',
    quantityUnits: units,
    idempotencyKey: `receipt-${tag(label)}`,
    receivedAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  return lot;
}

/** One line, whole packs, so the arrangement always reconciles. */
function line(
  fixture: Scenario,
  lotId: string,
  quantityUnits: number,
  expectedCreditMinor: number
) {
  return {
    inventoryLotId: lotId,
    stockLocationId: fixture.locationId,
    quantityUnits,
    reason: 'Short-dated stock agreed for return',
    returnWindowEndsAt: WINDOW_OPEN,
    expectedCreditMinor,
  };
}

/** Run one statement that is EXPECTED to fail, in its own transaction. */
async function expectRejection(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>
): Promise<string> {
  return inOrg(organizationId, (db) =>
    work(db)
      .then(() => 'ACCEPTED — the statement was expected to fail')
      .catch((error: Error) => error.message)
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ledger, returns, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./stock-ledger'),
    import('./supplier-returns-operations'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, ledger, returns };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // Finance journal entries reference the organization itself
  // (finance_journal_entries_visibility_fkey), so both tenants exist before any posting.
  await scopedDb.withPlatformDb((db) =>
    db.organization.createMany({
      data: [ORG_A, ORG_B].map((id) => ({
        id,
        slug: id,
        legalName: `Supplier returns ${id}`,
        displayName: `Supplier returns ${id}`,
        status: 'ACTIVE' as const,
      })),
      skipDuplicates: true,
    })
  );
}, 120_000);

// ── PUR-06 acceptance: a claimed quantity cannot be sold ────────────────────

describeIfDatabase('PUR-06 — a claimed quantity leaves saleable stock', () => {
  it('a DRAFT return reserves nothing, so the stock is still sellable', async () => {
    const fixture = await scenario(ORG_A, 'draft-inert');
    const result = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixture, 40, 'draft-inert');
      const created = await deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-${tag('draft-inert')}`,
        lines: [line(fixture, lot.id, 30, 36_000)],
      });
      const claims = await db.pharmacySupplierClaim.count({ where: { inventoryLotId: lot.id } });
      const sale = await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 30,
        at: NOW,
        idempotencyKeyPrefix: tag('draft-sale'),
      });
      return { status: created.status, claims, allocated: sale.allocations };
    });
    expect(result.status).toBe('DRAFT');
    expect(result.claims).toBe(0);
    expect(result.allocated.reduce((n, a) => n + a.units, 0)).toBe(30);
  });

  it('submitting the return reserves the quantity, posts its value, and makes it unsaleable', async () => {
    const fixture = await scenario(ORG_A, 'submit-reserves');
    const { submitted, journal } = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixture, 40, 'submit-reserves');
      const created = await deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-${tag('submit-reserves')}`,
        lines: [line(fixture, lot.id, 30, 36_000)],
      });
      const result = await deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        at: NOW,
      });
      const claimId = result.lines[0]!.supplierClaimId!;
      return {
        submitted: result,
        journal: await db.financeJournalEntry.findFirst({
          where: {
            organizationId: ORG_A,
            sourceKind: 'PHARMACY_SUPPLIER_CLAIM',
            sourceId: claimId,
          },
          include: { lines: true },
        }),
      };
    });
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.lines[0]!.supplierClaimId).not.toBeNull();
    expect(journal?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountCode: 'SUPPLIER_CLAIM_RECEIVABLE',
          side: 'DEBIT',
          amountMinor: 36_000,
        }),
        expect.objectContaining({
          accountCode: 'INVENTORY',
          side: 'CREDIT',
          amountMinor: 36_000,
        }),
      ])
    );

    // 40 on hand, 30 claimed: 11 is one more than what is left.
    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 11,
          at: NOW,
          idempotencyKeyPrefix: tag('claimed-sale'),
        })
      )
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });

    const remainder = await inOrg(ORG_A, (db) =>
      deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 10,
        at: NOW,
        idempotencyKeyPrefix: tag('unclaimed-sale'),
      })
    );
    expect(remainder.allocations.reduce((n, a) => n + a.units, 0)).toBe(10);
  });

  it('refuses to claim the same units twice', async () => {
    const fixture = await scenario(ORG_A, 'double-claim');
    const second = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixture, 40, 'double-claim');
      const first = await deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-A-${tag('double-claim')}`,
        lines: [line(fixture, lot.id, 30, 36_000)],
      });
      await deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: first.id,
        at: NOW,
      });
      return deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-B-${tag('double-claim')}`,
        lines: [line(fixture, lot.id, 11, 13_200)],
      });
    });

    await expect(
      inOrg(ORG_A, (db) =>
        deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
          purchaseReturnId: second.id,
          at: NOW,
        })
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_CLAIMED' });

    // The 10 units the first claim left over are still claimable, so the refusal
    // above was about the overlap and not about the lot being locked outright.
    const withinRemainder = await inOrg(ORG_A, async (db) => {
      const third = await deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-C-${tag('double-claim')}`,
        lines: [line(fixture, second.lines[0]!.inventoryLotId, 10, 12_000)],
      });
      return deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: third.id,
        at: NOW,
      });
    });
    expect(withinRemainder.status).toBe('SUBMITTED');
  });

  it('refuses to submit once the supplier return window has closed', async () => {
    const fixture = await scenario(ORG_A, 'window-closed');
    const created = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixture, 40, 'window-closed');
      return deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'PURCHASE_RETURN',
        reference: `RET-${tag('window-closed')}`,
        lines: [line(fixture, lot.id, 10, 12_000)],
      });
    });
    await expect(
      inOrg(ORG_A, (db) =>
        deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
          purchaseReturnId: created.id,
          at: new Date(WINDOW_OPEN.getTime() + 1),
        })
      )
    ).rejects.toMatchObject({ reason: 'RETURN_WINDOW_CLOSED' });
  });
});

// ── PUR-06: movements are append-only, under RETURN_TO_SUPPLIER ─────────────

describeIfDatabase('PUR-06 — dispatch posts an append-only RETURN_TO_SUPPLIER pair', () => {
  it('moves the units out of AVAILABLE and into RETURN_TO_SUPPLIER without leaving the ledger', async () => {
    const fixture = await scenario(ORG_A, 'dispatch');
    const outcome = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixture, 40, 'dispatch');
      const created = await deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-${tag('dispatch')}`,
        lines: [line(fixture, lot.id, 30, 36_000)],
      });
      await deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        at: NOW,
      });
      const dispatched = await deps.returns.dispatchPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        at: NOW,
        idempotencyKeyPrefix: tag('dispatch-key'),
      });
      const balances = await db.pharmacyStockBalance.findMany({
        where: { inventoryLotId: lot.id },
        orderBy: { disposition: 'asc' },
      });
      const claim = await db.pharmacySupplierClaim.findFirst({
        where: { inventoryLotId: lot.id },
      });
      return { dispatched, balances, claim, lotId: lot.id };
    });

    expect(
      await inOrg(ORG_A, (db) =>
        db.pharmacyControlledRegisterEntry.count({ where: { inventoryLotId: outcome.lotId } })
      )
    ).toBe(0);
    expect(outcome.dispatched.status).toBe('DISPATCHED');
    expect(outcome.dispatched.dispatchedWithRegisterPolicy).toBe(true);
    expect(outcome.balances).toEqual([
      expect.objectContaining({ disposition: 'AVAILABLE', onHandUnits: 10 }),
      expect.objectContaining({
        disposition: 'RETURN_TO_SUPPLIER',
        onHandUnits: 30,
        sealedPacks: 3,
        looseUnits: 0,
      }),
    ]);
    // The reservation is released at dispatch because the units have physically
    // left AVAILABLE; leaving it RESERVED would subtract them a second time.
    expect(outcome.claim?.status).toBe('SUBMITTED');

    // The 10 units that were never claimed remain sellable, and the returned
    // ones are not reachable by any sale.
    const sold = await inOrg(ORG_A, (db) =>
      deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 10,
        at: NOW,
        idempotencyKeyPrefix: tag('post-dispatch-sale'),
      })
    );
    expect(sold.allocations.reduce((n, a) => n + a.units, 0)).toBe(10);
    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 1,
          at: NOW,
          idempotencyKeyPrefix: tag('returned-sale'),
        })
      )
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
  });

  it('refuses to update or delete a RETURN_TO_SUPPLIER movement (§8A invariant 8)', async () => {
    const fixture = await scenario(ORG_A, 'append-only');
    const movementId = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixture, 20, 'append-only');
      const created = await deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-${tag('append-only')}`,
        lines: [line(fixture, lot.id, 10, 12_000)],
      });
      await deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        at: NOW,
      });
      await deps.returns.dispatchPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        at: NOW,
        idempotencyKeyPrefix: tag('append-key'),
      });
      const movement = await db.pharmacyStockMovement.findFirstOrThrow({
        where: { inventoryLotId: lot.id, disposition: 'RETURN_TO_SUPPLIER' },
      });
      return movement.id;
    });

    const updated = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.update({
        where: { id: movementId },
        data: { quantityUnits: 9999 },
      })
    );
    const deleted = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.delete({ where: { id: movementId } })
    );
    expect(updated).toContain('append-only');
    expect(deleted).toContain('append-only');
  });

  it('refuses to dispatch a return that was never submitted', async () => {
    const fixture = await scenario(ORG_A, 'dispatch-draft');
    const created = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixture, 20, 'dispatch-draft');
      return deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'PURCHASE_RETURN',
        reference: `RET-${tag('dispatch-draft')}`,
        lines: [line(fixture, lot.id, 10, 12_000)],
      });
    });
    await expect(
      inOrg(ORG_A, (db) =>
        deps.returns.dispatchPurchaseReturn(db, scopeOf(fixture), {
          purchaseReturnId: created.id,
          at: NOW,
          idempotencyKeyPrefix: tag('draft-dispatch-key'),
        })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSITION' });
  });
});

// ── PUR-06 acceptance: expected vs received credit is visible ───────────────

describeIfDatabase('PUR-06 — expected vs received credit', () => {
  async function dispatchedReturn(fixture: Scenario, label: string, expectedCreditMinor: number) {
    return inOrg(fixture.organizationId, async (db) => {
      const lot = await stockLot(db, fixture, 40, label);
      const created = await deps.returns.createPurchaseReturn(db, scopeOf(fixture), {
        supplierId: fixture.supplierId,
        kind: 'EXPIRY_CLAIM',
        reference: `RET-${tag(label)}`,
        lines: [line(fixture, lot.id, 30, expectedCreditMinor)],
      });
      await deps.returns.submitPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        at: NOW,
      });
      await deps.returns.dispatchPurchaseReturn(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        at: NOW,
        idempotencyKeyPrefix: tag(`${label}-key`),
      });
      return deps.returns.issueDebitNote(db, scopeOf(fixture), {
        purchaseReturnId: created.id,
        reference: `DN-${tag(label)}`,
        at: NOW,
      });
    });
  }

  it('shows the full claim outstanding before any credit arrives', async () => {
    const fixture = await scenario(ORG_A, 'expected-only');
    const note = await dispatchedReturn(fixture, 'expected-only', 36_000);
    expect(note.expectedCreditMinor).toBe(36_000);

    const positions = await inOrg(ORG_A, (db) => deps.returns.debitNotePositions(db, fixture));
    expect(positions.find((row) => row.debitNoteId === note.id)).toMatchObject({
      expectedCreditMinor: 36_000,
      receivedCreditMinor: 0,
      varianceMinor: 36_000,
      status: 'OPEN',
    });
  });

  it('keeps the shortfall visible when the supplier credits less than was claimed', async () => {
    const fixture = await scenario(ORG_A, 'short-credit');
    const note = await dispatchedReturn(fixture, 'short-credit', 36_000);
    const position = await inOrg(ORG_A, async (db) => {
      const credit = await deps.returns.recordSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
        supplierId: fixture.supplierId,
        reference: `CN-${tag('short-credit')}`,
        amountMinor: 30_000,
        receivedAt: NOW,
      });
      return deps.returns.allocateSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
        supplierCreditId: credit.id,
        debitNoteId: note.id,
        amountMinor: 30_000,
        at: NOW,
      });
    });
    expect(position.position).toMatchObject({
      expectedCreditMinor: 36_000,
      receivedCreditMinor: 30_000,
      varianceMinor: 6_000,
      status: 'PARTIALLY_SETTLED',
    });
    expect(position.debitNote.status).toBe('PARTIALLY_SETTLED');
  });

  it('settles the note and the return once the whole claim is credited', async () => {
    const fixture = await scenario(ORG_A, 'full-credit');
    const note = await dispatchedReturn(fixture, 'full-credit', 36_000);
    // Two credit notes, because one credit contributes one amount to one debit
    // note: the allocation table is unique on that pair and append-only, so a
    // second tranche is a second credit rather than a rewritten allocation.
    const settled = await inOrg(ORG_A, async (db) => {
      const first = await deps.returns.recordSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
        supplierId: fixture.supplierId,
        reference: `CN-A-${tag('full-credit')}`,
        amountMinor: 20_000,
        receivedAt: NOW,
      });
      const second = await deps.returns.recordSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
        supplierId: fixture.supplierId,
        reference: `CN-B-${tag('full-credit')}`,
        amountMinor: 16_000,
        receivedAt: NOW,
      });
      const partial = await deps.returns.allocateSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
        supplierCreditId: first.id,
        debitNoteId: note.id,
        amountMinor: 20_000,
        at: NOW,
      });
      expect(partial.position.status).toBe('PARTIALLY_SETTLED');
      const final = await deps.returns.allocateSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
        supplierCreditId: second.id,
        debitNoteId: note.id,
        amountMinor: 16_000,
        at: NOW,
      });
      const purchaseReturn = await db.pharmacyPurchaseReturn.findFirstOrThrow({
        where: { id: note.purchaseReturnId },
      });
      return { final, purchaseReturn };
    });
    expect(settled.final.position).toMatchObject({
      receivedCreditMinor: 36_000,
      varianceMinor: 0,
      status: 'SETTLED',
    });
    expect(settled.purchaseReturn.status).toBe('SETTLED');
  });

  it('refuses to allocate more credit than the note is owed', async () => {
    const fixture = await scenario(ORG_A, 'over-allocate');
    const note = await dispatchedReturn(fixture, 'over-allocate', 36_000);
    await expect(
      inOrg(ORG_A, async (db) => {
        const credit = await deps.returns.recordSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
          supplierId: fixture.supplierId,
          reference: `CN-${tag('over-allocate')}`,
          amountMinor: 50_000,
          receivedAt: NOW,
        });
        return deps.returns.allocateSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
          supplierCreditId: credit.id,
          debitNoteId: note.id,
          amountMinor: 36_001,
          at: NOW,
        });
      })
    ).rejects.toMatchObject({ reason: 'OVER_ALLOCATION' });
  });

  it('keeps the actor who submitted the return off its own settlement', async () => {
    const fixture = await scenario(ORG_A, 'segregation');
    const note = await dispatchedReturn(fixture, 'segregation', 12_000);
    await expect(
      inOrg(ORG_A, async (db) => {
        const credit = await deps.returns.recordSupplierCredit(db, scopeOf(fixture), {
          supplierId: fixture.supplierId,
          reference: `CN-${tag('segregation')}`,
          amountMinor: 12_000,
          receivedAt: NOW,
        });
        // CLERK submitted this return in `dispatchedReturn`.
        return deps.returns.allocateSupplierCredit(db, scopeOf(fixture, CLERK), {
          supplierCreditId: credit.id,
          debitNoteId: note.id,
          amountMinor: 12_000,
          at: NOW,
        });
      })
    ).rejects.toMatchObject({ reason: 'SELF_APPROVAL' });
  });

  it('refuses to rewrite a settlement allocation (§8A invariant 15)', async () => {
    const fixture = await scenario(ORG_A, 'allocation-append-only');
    const note = await dispatchedReturn(fixture, 'allocation-append-only', 12_000);
    const allocationId = await inOrg(ORG_A, async (db) => {
      const credit = await deps.returns.recordSupplierCredit(db, scopeOf(fixture, CONTROLLER), {
        supplierId: fixture.supplierId,
        reference: `CN-${tag('allocation-append-only')}`,
        amountMinor: 12_000,
        receivedAt: NOW,
      });
      const { allocation } = await deps.returns.allocateSupplierCredit(
        db,
        scopeOf(fixture, CONTROLLER),
        { supplierCreditId: credit.id, debitNoteId: note.id, amountMinor: 12_000, at: NOW }
      );
      return allocation.id;
    });
    const updated = await expectRejection(ORG_A, (db) =>
      db.pharmacySupplierCreditAllocation.update({
        where: { id: allocationId },
        data: { amountMinor: 1 },
      })
    );
    const deleted = await expectRejection(ORG_A, (db) =>
      db.pharmacySupplierCreditAllocation.delete({ where: { id: allocationId } })
    );
    expect(updated).toContain('append-only');
    expect(deleted).toContain('append-only');
  });
});

// ── Tenant isolation, forced ────────────────────────────────────────────────

describeIfDatabase('PUR-06 — tenant isolation', () => {
  it('never shows one tenant another tenant’s returns or debit notes', async () => {
    const fixtureA = await scenario(ORG_A, 'isolation-a');
    await scenario(ORG_B, 'isolation-b');
    const reference = `RET-${tag('isolation')}`;
    await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, fixtureA, 20, 'isolation');
      await deps.returns.createPurchaseReturn(db, scopeOf(fixtureA), {
        supplierId: fixtureA.supplierId,
        kind: 'PURCHASE_RETURN',
        reference,
        lines: [line(fixtureA, lot.id, 10, 12_000)],
      });
    });

    const seenByOwner = await inOrg(ORG_A, (db) =>
      db.pharmacyPurchaseReturn.count({ where: { reference } })
    );
    const seenByStranger = await inOrg(ORG_B, (db) =>
      db.pharmacyPurchaseReturn.count({ where: { reference } })
    );
    expect(seenByOwner).toBe(1);
    expect(seenByStranger).toBe(0);
  });
});
