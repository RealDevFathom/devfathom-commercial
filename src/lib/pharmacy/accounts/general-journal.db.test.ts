// @vitest-environment node
/**
 * CEO-JVCORE-20261025 — the journal voucher lifecycle against PostgreSQL:
 * versioned drafts, once-per-document posting, payload-stable replay, the
 * linked canonical reversal, the immutability triggers, branch-scoped RLS and
 * the shared ledger lock. Skips without a database URL.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.M8_TEST_OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const organizationId = `org_jv_${suffix}`;
const otherOrganizationId = `org_jv_other_${suffix}`;
const branchId = `branch_jv_${suffix}`;
const otherBranchId = `branch_jv_b_${suffix}`;
const actorId = `owner_jv_${suffix}`;
const scope = { organizationId, branchId, actorId };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  jv: typeof import('./general-journal');
  bookkeeping: typeof import('../bookkeeping');
};
let deps: Deps;
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>, org = organizationId) =>
  deps.withTenantDb(org, work, { timeout: 30_000 });

function draft(n: number, overrides: Record<string, unknown> = {}) {
  return {
    branchId,
    createKey: `create-${suffix}-${n}`,
    reference: `JV-${suffix}-${n}`,
    purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
    occurredAt: '2026-10-10T09:00:00.000Z',
    currency: 'PKR' as const,
    reason: 'Electricity accrual',
    evidenceReference: `BILL-${n}`,
    lines: [
      { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT' as const, amountMinor: 12_500 },
      { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT' as const, amountMinor: 12_500 },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, jv, bookkeeping, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./general-journal'),
    import('../bookkeeping'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, jv, bookkeeping };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    for (const [org, slug] of [
      [organizationId, `jv-${suffix}`],
      [otherOrganizationId, `jv-other-${suffix}`],
    ]) {
      await owner.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$2,'JV fixture','JV fixture','ACTIVE','SHARED',now(),now())`,
        [org, slug]
      );
    }
    for (const [id, code] of [
      [branchId, `JVA-${suffix}`],
      [otherBranchId, `JVB-${suffix}`],
    ]) {
      await owner.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'JV pharmacy','1 Test Road','Lahore','PB',now(),now())`,
        [id, organizationId, code]
      );
    }
  } finally {
    await owner.end();
  }
}, 120_000);

describeDb('pharmacy journal voucher lifecycle', () => {
  it('saves, reloads and versions a draft, then posts it once with a stable replay', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(1)));
    const replayed = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(1)));
    expect(replayed.id).toBe(created.id);

    const reloaded = await inTenant((db) => deps.jv.getJournalVoucher(db, scope, created.id));
    expect(reloaded).toMatchObject({ status: 'DRAFT', version: 1 });
    expect(reloaded.lines.map((line) => `${line.accountCode}:${line.side}`)).toEqual([
      'OPERATING_EXPENSE:DEBIT',
      'MANUAL_NONTRADE_ACCRUAL:CREDIT',
    ]);

    const edited = await inTenant((db) =>
      deps.jv.updateJournalVoucherDraft(db, scope, {
        ...draft(1, {
          lines: [
            { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 15_000 },
            { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 15_000 },
          ],
        }),
        voucherId: created.id,
        expectedVersion: 1,
      })
    );
    expect(edited.version).toBe(2);
    await expect(
      inTenant((db) =>
        deps.jv.updateJournalVoucherDraft(db, scope, {
          ...draft(1),
          voucherId: created.id,
          expectedVersion: 1,
        })
      )
    ).rejects.toMatchObject({ reason: 'STALE_VERSION' });

    const post = {
      branchId,
      voucherId: created.id,
      expectedVersion: 2,
      commandKey: `post-${suffix}-1`,
    };
    const first = await inTenant((db) => deps.jv.postJournalVoucher(db, scope, post));
    expect(first.voucher.status).toBe('POSTED');
    const again = await inTenant((db) => deps.jv.postJournalVoucher(db, scope, post));
    expect(again).toMatchObject({ replayed: true });
    expect(again.voucher.journalEntryId).toBe(first.voucher.journalEntryId);
    await expect(
      inTenant((db) => deps.jv.postJournalVoucher(db, scope, { ...post, expectedVersion: 1 }))
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      inTenant((db) =>
        deps.jv.postJournalVoucher(db, scope, { ...post, commandKey: `post-${suffix}-1b` })
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_POSTED' });

    const entries = await inTenant((db) =>
      db.financeJournalEntry.findMany({
        where: { organizationId, sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: created.id },
        include: { lines: true },
      })
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lines.map((line) => line.amountMinor)).toEqual([15_000, 15_000]);
  }, 60_000);

  it('serializes racing posts with different keys into exactly one ledger entry', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(2)));
    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((key) =>
        inTenant((db) =>
          deps.jv.postJournalVoucher(db, scope, {
            branchId,
            voucherId: created.id,
            expectedVersion: 1,
            commandKey: `race-${suffix}-${key}`,
          })
        )
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const entries = await inTenant((db) =>
      db.financeJournalEntry.count({
        where: { organizationId, sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: created.id },
      })
    );
    expect(entries).toBe(1);
  }, 60_000);

  it('freezes posted vouchers and their lines in the database', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(3)));
    await inTenant((db) =>
      deps.jv.postJournalVoucher(db, scope, {
        branchId,
        voucherId: created.id,
        expectedVersion: 1,
        commandKey: `post-${suffix}-3`,
      })
    );
    await expect(
      inTenant((db) =>
        db.pharmacyJournalVoucher.update({
          where: { id: created.id },
          data: { reason: 'rewritten' },
        })
      )
    ).rejects.toThrow(/immutable/);
    await expect(
      inTenant((db) =>
        db.pharmacyJournalVoucherLine.updateMany({
          where: { organizationId, voucherId: created.id },
          data: { amountMinor: 1 },
        })
      )
    ).rejects.toThrow(/immutable outside DRAFT/);
    await expect(
      inTenant((db) => db.pharmacyJournalVoucher.delete({ where: { id: created.id } }))
    ).rejects.toThrow(/cannot be deleted/);
  }, 60_000);

  it('reverses once with a linked canonical entry and refuses a closed period', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(4)));
    const posted = await inTenant((db) =>
      deps.jv.postJournalVoucher(db, scope, {
        branchId,
        voucherId: created.id,
        expectedVersion: 1,
        commandKey: `post-${suffix}-4`,
      })
    );
    await inTenant((db) =>
      deps.bookkeeping.closeAccountingPeriod(db, scope, {
        startsAt: new Date('2026-10-20T00:00:00Z'),
        endsAt: new Date('2026-10-21T00:00:00Z'),
      })
    );
    await expect(
      inTenant((db) =>
        deps.jv.reverseJournalVoucher(db, scope, {
          branchId,
          voucherId: created.id,
          commandKey: `reverse-${suffix}-4a`,
          reason: 'Wrong branch',
          at: '2026-10-20T12:00:00.000Z',
        })
      )
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });

    const reverse = {
      branchId,
      voucherId: created.id,
      commandKey: `reverse-${suffix}-4`,
      reason: 'Wrong branch',
      at: '2026-10-22T12:00:00.000Z',
    };
    const reversed = await inTenant((db) => deps.jv.reverseJournalVoucher(db, scope, reverse));
    expect(reversed.voucher.status).toBe('REVERSED');
    const reversal = await inTenant((db) =>
      db.financeJournalEntry.findFirstOrThrow({
        where: { organizationId, id: reversed.voucher.reversalEntryId! },
      })
    );
    expect(reversal.reversesEntryId).toBe(posted.voucher.journalEntryId);
    await expect(
      inTenant((db) => deps.jv.reverseJournalVoucher(db, scope, reverse))
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      inTenant((db) =>
        deps.jv.reverseJournalVoucher(db, scope, { ...reverse, commandKey: `reverse-${suffix}-4b` })
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_REVERSED' });
  }, 60_000);

  it('hides vouchers from another branch scope and another organization', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(5)));
    await expect(
      inTenant((db) =>
        deps.jv.getJournalVoucher(db, { organizationId, branchId: otherBranchId }, created.id)
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const visible = await inTenant(
      (db) => db.pharmacyJournalVoucher.findMany({ where: { id: created.id } }),
      otherOrganizationId
    );
    expect(visible).toEqual([]);
  }, 60_000);

  // DEV-949: a create replay returns the saved voucher only when its details match.
  it('replays an identical create and refuses the same create key with changed details', async () => {
    const original = draft(8, {
      lines: [
        { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 12_500, memo: 'Meter 1' },
        { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 12_500 },
      ],
    });
    const savedRows = () =>
      inTenant((db) =>
        db.pharmacyJournalVoucher.findMany({
          where: { createKey: original.createKey },
          include: { lines: { orderBy: { lineNumber: 'asc' } } },
        })
      );
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, original));
    const before = await savedRows();
    expect(before).toHaveLength(1);

    // Same key and the same details after normalisation: the same voucher, nothing new.
    const replayed = await inTenant((db) =>
      deps.jv.createJournalVoucherDraft(db, scope, {
        ...original,
        reference: `  ${original.reference} `,
        reason: `${original.reason}  `,
        evidenceReference: ` ${original.evidenceReference}`,
        lines: [...original.lines].reverse(),
      })
    );
    expect(replayed.id).toBe(created.id);
    await expect(savedRows()).resolves.toEqual(before);

    // Same key, different details: refused, and the saved voucher and its lines stay as they were.
    const changed: Record<string, Record<string, unknown>> = {
      reference: { reference: `JV-${suffix}-8-changed` },
      amount: {
        lines: [
          { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 99_000, memo: 'Meter 1' },
          { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 99_000 },
        ],
      },
      memo: {
        lines: [
          { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 12_500, memo: 'Meter 2' },
          { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 12_500 },
        ],
      },
      currency: { currency: 'USD' },
      occurredAt: { occurredAt: '2026-10-11T09:00:00.000Z' },
      reason: { reason: 'Water accrual' },
      evidenceReference: { evidenceReference: 'BILL-8-changed' },
    };
    for (const [field, overrides] of Object.entries(changed)) {
      await expect(
        inTenant((db) =>
          deps.jv.createJournalVoucherDraft(db, scope, { ...original, ...overrides })
        ),
        field
      ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    }
    await expect(savedRows()).resolves.toEqual(before);
    await expect(
      inTenant((db) =>
        db.pharmacyJournalVoucher.count({ where: { reference: `JV-${suffix}-8-changed` } })
      )
    ).resolves.toBe(0);

    // Another actor with the same key stays refused, even with identical details.
    await expect(
      inTenant((db) =>
        deps.jv.createJournalVoucherDraft(db, { ...scope, actorId: `clerk_jv_${suffix}` }, original)
      )
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });

    // Once the draft is edited, replaying the original create no longer matches the saved
    // voucher and is refused rather than returning the edited one as if it were the create.
    const edited = await inTenant((db) =>
      deps.jv.updateJournalVoucherDraft(db, scope, {
        ...original,
        reason: 'Electricity accrual, corrected',
        voucherId: created.id,
        expectedVersion: 1,
      })
    );
    expect(edited.version).toBe(2);
    await expect(
      inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, original))
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    const [after] = await savedRows();
    expect(after).toMatchObject({
      id: created.id,
      version: 2,
      status: 'DRAFT',
      reason: 'Electricity accrual, corrected',
    });
    expect(after!.lines.map((line) => [line.amountMinor, line.memo])).toEqual([
      [12_500, 'Meter 1'],
      [12_500, null],
    ]);
  }, 60_000);

  // DEV-953: creates racing on one key end with one voucher and a stable outcome, never a
  // unique-index error from the database.
  it('settles racing creates with the same key or reference into one voucher', async () => {
    const rounds = 15;
    for (let round = 0; round < rounds; round += 1) {
      const base = 1_000 + round * 10;

      // Identical creates sent together: every one ends with the same voucher.
      const identical = draft(base);
      const same = await Promise.allSettled(
        [0, 1, 2, 3].map(() =>
          inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, identical))
        )
      );
      const sameIds = same.map((result) => {
        expect(
          result.status,
          `round ${round} identical: ${result.status === 'rejected' ? String(result.reason) : ''}`
        ).toBe('fulfilled');
        return (result as PromiseFulfilledResult<{ id: string }>).value.id;
      });
      expect(new Set(sameIds).size, `round ${round} identical`).toBe(1);
      await expect(
        inTenant((db) =>
          db.pharmacyJournalVoucher.count({ where: { createKey: identical.createKey } })
        )
      ).resolves.toBe(1);

      // The same key with different details sent together: one voucher, one plain conflict.
      const keyed = draft(base + 1);
      const conflict = await Promise.allSettled([
        inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, keyed)),
        inTenant((db) =>
          deps.jv.createJournalVoucherDraft(db, scope, {
            ...keyed,
            evidenceReference: `${keyed.evidenceReference}-changed`,
          })
        ),
      ]);
      const conflictWins = conflict.filter((result) => result.status === 'fulfilled');
      const conflictLosses = conflict.filter((result) => result.status === 'rejected');
      expect(conflictWins, `round ${round} same key`).toHaveLength(1);
      expect(conflictLosses, `round ${round} same key`).toHaveLength(1);
      expect(conflictLosses[0]!.reason).toBeInstanceOf(deps.jv.PharmacyJournalVoucherError);
      expect(conflictLosses[0]!.reason).toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
      await expect(
        inTenant((db) => db.pharmacyJournalVoucher.count({ where: { createKey: keyed.createKey } }))
      ).resolves.toBe(1);

      // Different keys sharing one reference sent together: one voucher, one duplicate reference.
      const shared = draft(base + 2);
      const reference = await Promise.allSettled([
        inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, shared)),
        inTenant((db) =>
          deps.jv.createJournalVoucherDraft(db, scope, {
            ...shared,
            createKey: `${shared.createKey}-other`,
          })
        ),
      ]);
      const referenceWins = reference.filter((result) => result.status === 'fulfilled');
      const referenceLosses = reference.filter((result) => result.status === 'rejected');
      expect(referenceWins, `round ${round} reference`).toHaveLength(1);
      expect(referenceLosses, `round ${round} reference`).toHaveLength(1);
      expect(referenceLosses[0]!.reason).toBeInstanceOf(deps.jv.PharmacyJournalVoucherError);
      expect(referenceLosses[0]!.reason).toMatchObject({ reason: 'DUPLICATE_REFERENCE' });
      await expect(
        inTenant((db) =>
          db.pharmacyJournalVoucher.count({ where: { reference: shared.reference } })
        )
      ).resolves.toBe(1);
    }
  }, 180_000);

  // DEV-947: nested line rows take their organization and branch from the voucher.
  it('stores every line under its voucher scope and refuses cross-scope and unbalanced writes', async () => {
    const linesOf = (voucherId: string, org = organizationId) =>
      inTenant(
        (db) =>
          db.pharmacyJournalVoucherLine.findMany({
            where: { voucherId },
            orderBy: { lineNumber: 'asc' },
          }),
        org
      );
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(6)));
    const replayed = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(6)));
    expect(replayed.id).toBe(created.id);
    const createdLines = await linesOf(created.id);
    expect(createdLines).toHaveLength(2);
    for (const line of createdLines) {
      expect(line).toMatchObject({ organizationId, branchId, voucherId: created.id });
    }

    const edited = await inTenant((db) =>
      deps.jv.updateJournalVoucherDraft(db, scope, {
        ...draft(6, {
          lines: [
            { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 20_000 },
            { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 20_000 },
          ],
        }),
        voucherId: created.id,
        expectedVersion: 1,
      })
    );
    expect(edited.version).toBe(2);
    const editedLines = await linesOf(created.id);
    expect(editedLines.map((line) => [line.lineNumber, line.amountMinor])).toEqual([
      [1, 20_000],
      [2, 20_000],
    ]);
    for (const line of editedLines) {
      expect(line).toMatchObject({ organizationId, branchId, voucherId: created.id });
    }

    // An unbalanced voucher is refused and nothing is written.
    await expect(
      inTenant((db) =>
        deps.jv.createJournalVoucherDraft(
          db,
          scope,
          draft(7, {
            lines: [
              { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 12_500 },
              { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 12_000 },
            ],
          })
        )
      )
    ).rejects.toMatchObject({ reason: 'UNBALANCED' });
    await expect(
      inTenant((db) =>
        db.pharmacyJournalVoucher.count({ where: { createKey: `create-${suffix}-7` } })
      )
    ).resolves.toBe(0);

    // Another branch of the same organization can neither edit nor post it.
    const otherBranchScope = { organizationId, branchId: otherBranchId, actorId };
    await expect(
      inTenant((db) =>
        deps.jv.updateJournalVoucherDraft(db, otherBranchScope, {
          ...draft(6),
          branchId: otherBranchId,
          voucherId: created.id,
          expectedVersion: 2,
        })
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    await expect(
      inTenant((db) =>
        deps.jv.postJournalVoucher(db, otherBranchScope, {
          branchId: otherBranchId,
          voucherId: created.id,
          expectedVersion: 2,
          commandKey: `post-${suffix}-6-other-branch`,
        })
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    // A line cannot point at this voucher under a different branch (composite key).
    await expect(
      inTenant((db) =>
        db.pharmacyJournalVoucherLine.create({
          data: {
            organizationId,
            branchId: otherBranchId,
            voucherId: created.id,
            lineNumber: 3,
            accountCode: 'OPERATING_EXPENSE',
            side: 'DEBIT',
            amountMinor: 1,
          },
        })
      )
    ).rejects.toThrow(/foreign key/i);
    // Row-level security with the other branch selected hides the voucher and its lines.
    const branchView = await inTenant(async (db) => {
      await db.$queryRawUnsafe(
        `SELECT set_config('app.current_branch_id', $1, true)`,
        otherBranchId
      );
      return {
        vouchers: await db.pharmacyJournalVoucher.count({ where: { id: created.id } }),
        lines: await db.pharmacyJournalVoucherLine.count({ where: { voucherId: created.id } }),
        updated: await db.pharmacyJournalVoucherLine.updateMany({
          where: { voucherId: created.id },
          data: { memo: 'other branch' },
        }),
      };
    });
    expect(branchView).toEqual({ vouchers: 0, lines: 0, updated: { count: 0 } });

    // Another organization can neither read nor write the voucher or its lines.
    await expect(linesOf(created.id, otherOrganizationId)).resolves.toEqual([]);
    await expect(
      inTenant(
        (db) =>
          db.pharmacyJournalVoucher.updateMany({
            where: { id: created.id },
            data: { reason: 'other organization' },
          }),
        otherOrganizationId
      )
    ).resolves.toEqual({ count: 0 });
    await expect(
      inTenant(
        (db) =>
          db.pharmacyJournalVoucherLine.updateMany({
            where: { voucherId: created.id },
            data: { amountMinor: 1 },
          }),
        otherOrganizationId
      )
    ).resolves.toEqual({ count: 0 });
    // The line guard runs as the caller, cannot see the voucher under RLS and refuses it;
    // the tenant policy would refuse the row next.
    await expect(
      inTenant(
        (db) =>
          db.pharmacyJournalVoucherLine.create({
            data: {
              organizationId,
              branchId,
              voucherId: created.id,
              lineNumber: 3,
              accountCode: 'OPERATING_EXPENSE',
              side: 'DEBIT',
              amountMinor: 1,
            },
          }),
        otherOrganizationId
      )
    ).rejects.toThrow(/immutable outside DRAFT|row-level security/i);

    // The draft is intact and still posts as the restricted runtime role.
    await expect(linesOf(created.id)).resolves.toEqual(editedLines);
    const posted = await inTenant((db) =>
      deps.jv.postJournalVoucher(db, scope, {
        branchId,
        voucherId: created.id,
        expectedVersion: 2,
        commandKey: `post-${suffix}-6`,
      })
    );
    expect(posted.voucher).toMatchObject({ status: 'POSTED', reason: 'Electricity accrual' });
    const entry = await inTenant((db) =>
      db.financeJournalEntry.findFirstOrThrow({
        where: { organizationId, id: posted.voucher.journalEntryId! },
        include: { lines: true },
      })
    );
    expect(entry.branchId).toBe(branchId);
    expect(entry.lines.map((line) => line.amountMinor)).toEqual([20_000, 20_000]);
  }, 60_000);
});
