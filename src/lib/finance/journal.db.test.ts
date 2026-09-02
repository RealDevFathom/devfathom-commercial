/**
 * FIN-01 / §8A invariant 15 — the shared journal against migrated PostgreSQL
 * with FORCED row level security.
 *
 * Every claim in this file is a claim about the DATABASE, not about the module:
 * "an unbalanced entry cannot commit" is a DEFERRABLE constraint trigger, "a
 * posting is never edited" is an append-only trigger, "a reversal negates
 * exactly" is a second deferred trigger, and "another tenant's postings are
 * invisible" is an RLS predicate. Against a mock, all four would pass whatever
 * the migration actually said. Skipped — never silently passed — when the
 * database URL is absent.
 *
 * THE DEFERRED CHECKS FIRE AT COMMIT. A test that provokes one therefore has to
 * let the whole transaction end and assert on the rejection of `withTenantDb`
 * itself; the failing statement is not the INSERT, it is the COMMIT.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1183_j_a_${suffix}`;
const ORG_B = `org_wha1183_j_b_${suffix}`;
const BRANCH_A = `branch_j_a_${suffix}`;
const ACTOR = 'user_bookkeeper';

/** Fixed instants, so no case depends on the wall clock. */
const NOW = new Date('2026-09-02T09:00:00.000Z');
const LATER = new Date('2026-09-03T09:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  journal: typeof import('./journal');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

let unique = 0;
function key(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

function scopeOf(organizationId: string) {
  return { organizationId, actorId: ACTOR };
}

/**
 * Run a transaction that is EXPECTED to be rejected, and return the message.
 * Returning a sentinel on success keeps a silently-accepted write from reading
 * as a pass.
 */
async function expectRejection(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>
): Promise<string> {
  return inOrg(organizationId, work)
    .then(() => 'ACCEPTED — the transaction was expected to be rejected')
    .catch((error: Error) => error.message);
}

/** A minimal balanced entry: cost relieved against inventory. */
function balancedLines(amountMinor = 1200) {
  return [
    { accountCode: 'COST_OF_GOODS_SOLD' as const, side: 'DEBIT' as const, amountMinor },
    { accountCode: 'INVENTORY' as const, side: 'CREDIT' as const, amountMinor },
  ];
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, journal, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./journal'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, journal };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
}, 120_000);

describeIfDatabase('finance journal — FIN-01 balanced postings', () => {
  it('posts an entry whose debits equal its credits and traces it to its source', async () => {
    const sourceId = key('src');
    const entry = await inOrg(ORG_A, (db) =>
      deps.journal.postJournalEntry(db, scopeOf(ORG_A), {
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId,
        description: 'Balanced posting',
        occurredAt: NOW,
        idempotencyKey: key('post'),
        branchId: BRANCH_A,
        lines: balancedLines(),
      })
    );

    expect(entry.sourceKind).toBe('PHARMACY_SALE_LINE');
    expect(entry.sourceId).toBe(sourceId);
    expect(entry.lines).toHaveLength(2);
    const debits = entry.lines
      .filter((line) => line.side === 'DEBIT')
      .reduce((sum, line) => sum + line.amountMinor, 0);
    const credits = entry.lines
      .filter((line) => line.side === 'CREDIT')
      .reduce((sum, line) => sum + line.amountMinor, 0);
    expect(debits).toBe(credits);
  });

  it('refuses an unbalanced entry at COMMIT, even when the module check is bypassed', async () => {
    // Written with raw statements on purpose: `postJournalEntry` would refuse
    // this in TypeScript, and the claim under test is that the DATABASE refuses
    // it too. Both sides are present and only the totals disagree, so this
    // reaches the balance check rather than stopping at the completeness one.
    const message = await expectRejection(ORG_A, async (db) => {
      const entryId = key('unbalanced-entry');
      await db.$executeRaw`
        INSERT INTO "finance_journal_entries"
          ("id","organizationId","branchId","sourceKind","sourceId","description","actorId","occurredAt","idempotencyKey")
        VALUES (${entryId}, ${ORG_A}, ${BRANCH_A}, 'PHARMACY_SALE_LINE', ${key('src')},
                'Out by one minor unit', ${ACTOR}, ${NOW}, ${key('idem')})`;
      await db.$executeRaw`
        INSERT INTO "finance_journal_lines"
          ("id","organizationId","entryId","accountCode","side","amountMinor")
        VALUES (${key('leg')}, ${ORG_A}, ${entryId}, 'COST_OF_GOODS_SOLD', 'DEBIT', 1200)`;
      await db.$executeRaw`
        INSERT INTO "finance_journal_lines"
          ("id","organizationId","entryId","accountCode","side","amountMinor")
        VALUES (${key('leg')}, ${ORG_A}, ${entryId}, 'INVENTORY', 'CREDIT', 1199)`;
    });

    expect(message).toContain('FINANCE_ENTRY_UNBALANCED');
  });

  it('refuses a one-sided entry whose legs happen to sum to the same total', async () => {
    const message = await expectRejection(ORG_A, async (db) => {
      const entryId = key('one-sided-entry');
      await db.$executeRaw`
        INSERT INTO "finance_journal_entries"
          ("id","organizationId","sourceKind","sourceId","description","actorId","occurredAt","idempotencyKey")
        VALUES (${entryId}, ${ORG_A}, 'PHARMACY_SALE_LINE', ${key('src')},
                'Debits only', ${ACTOR}, ${NOW}, ${key('idem')})`;
      await db.$executeRaw`
        INSERT INTO "finance_journal_lines"
          ("id","organizationId","entryId","accountCode","side","amountMinor")
        VALUES (${key('leg')}, ${ORG_A}, ${entryId}, 'INVENTORY', 'DEBIT', 600)`;
      await db.$executeRaw`
        INSERT INTO "finance_journal_lines"
          ("id","organizationId","entryId","accountCode","side","amountMinor")
        VALUES (${key('leg')}, ${ORG_A}, ${entryId}, 'COST_OF_GOODS_SOLD', 'DEBIT', 600)`;
    });

    expect(message).toContain('FINANCE_ENTRY_UNBALANCED');
  });

  it('refuses an entry that never got any legs at all', async () => {
    const message = await expectRejection(ORG_A, (db) =>
      db.financeJournalEntry.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          sourceKind: 'PHARMACY_GOODS_RECEIPT',
          sourceId: key('src'),
          description: 'No legs',
          actorId: ACTOR,
          occurredAt: NOW,
          idempotencyKey: key('idem'),
        },
      })
    );

    expect(message).toContain('FINANCE_ENTRY_INCOMPLETE');
  });

  it('refuses a zero-value leg', async () => {
    const message = await expectRejection(ORG_A, async (db) => {
      const entryId = key('zero-entry');
      await db.$executeRaw`
        INSERT INTO "finance_journal_entries"
          ("id","organizationId","sourceKind","sourceId","description","actorId","occurredAt","idempotencyKey")
        VALUES (${entryId}, ${ORG_A}, 'PHARMACY_SALE_LINE', ${key('src')}, 'Zero leg',
                ${ACTOR}, ${NOW}, ${key('idem')})`;
      await db.$executeRaw`
        INSERT INTO "finance_journal_lines"
          ("id","organizationId","entryId","accountCode","side","amountMinor")
        VALUES (${key('leg')}, ${ORG_A}, ${entryId}, 'INVENTORY', 'DEBIT', 0)`;
    });

    expect(message).toContain('finance_journal_lines_amount_positive');
  });

  it('posts once for a repeated idempotency key', async () => {
    const idempotencyKey = key('replay');
    const sourceId = key('src');
    const first = await inOrg(ORG_A, (db) =>
      deps.journal.postJournalEntry(db, scopeOf(ORG_A), {
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId,
        description: 'Replayed posting',
        occurredAt: NOW,
        idempotencyKey,
        lines: balancedLines(700),
      })
    );
    const second = await inOrg(ORG_A, (db) =>
      deps.journal.postJournalEntry(db, scopeOf(ORG_A), {
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId,
        description: 'Replayed posting',
        occurredAt: NOW,
        idempotencyKey,
        lines: balancedLines(700),
      })
    );

    expect(second.id).toBe(first.id);
    const entries = await inOrg(ORG_A, (db) =>
      db.financeJournalEntry.count({ where: { organizationId: ORG_A, idempotencyKey } })
    );
    expect(entries).toBe(1);
  });
});

describeIfDatabase('finance journal — §8A invariant 15 reversal is additive', () => {
  async function postOne(label: string, amountMinor = 1500) {
    return inOrg(ORG_A, (db) =>
      deps.journal.postJournalEntry(db, scopeOf(ORG_A), {
        sourceKind: 'PHARMACY_GOODS_RECEIPT',
        sourceId: key(`${label}-src`),
        description: `Posting ${label}`,
        occurredAt: NOW,
        idempotencyKey: key(`${label}-idem`),
        branchId: BRANCH_A,
        lines: [
          { accountCode: 'INVENTORY', side: 'DEBIT', amountMinor, lotId: `lot-${label}` },
          { accountCode: 'GOODS_RECEIVED_ACCRUAL', side: 'CREDIT', amountMinor },
        ],
      })
    );
  }

  it('adds a linked negation and leaves the original posting byte-for-byte intact', async () => {
    const original = await postOne('reversal');
    const reversal = await inOrg(ORG_A, (db) =>
      deps.journal.reverseJournalEntry(db, scopeOf(ORG_A), {
        entryId: original.id,
        reason: 'Delivery taken back',
        at: LATER,
        idempotencyKey: key('reversal-idem'),
      })
    );

    expect(reversal.id).not.toBe(original.id);
    expect(reversal.reversesEntryId).toBe(original.id);
    expect(reversal.reversalReason).toBe('Delivery taken back');
    // Same source reference: the reversal is evidence about the SAME event.
    expect(reversal.sourceId).toBe(original.sourceId);

    const after = await inOrg(ORG_A, (db) =>
      db.financeJournalEntry.findFirstOrThrow({
        where: { organizationId: ORG_A, id: original.id },
        include: { lines: { orderBy: { id: 'asc' } } },
      })
    );
    expect(after.description).toBe(original.description);
    expect(after.occurredAt).toEqual(original.occurredAt);
    expect(after.lines.map((line) => [line.accountCode, line.side, line.amountMinor])).toEqual(
      original.lines
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((line) => [line.accountCode, line.side, line.amountMinor])
    );

    // The pair nets to nothing, per account and per dimension.
    const net = new Map<string, number>();
    for (const line of [...original.lines, ...reversal.lines]) {
      const bucket = `${line.accountCode}:${line.lotId ?? ''}`;
      const signed = deps.journal.signedMinor(line);
      net.set(bucket, (net.get(bucket) ?? 0) + signed);
    }
    expect([...net.values()].every((value) => value === 0)).toBe(true);
  });

  it('reverses an entry at most once', async () => {
    const original = await postOne('once');
    await inOrg(ORG_A, (db) =>
      deps.journal.reverseJournalEntry(db, scopeOf(ORG_A), {
        entryId: original.id,
        reason: 'First reversal',
        at: LATER,
        idempotencyKey: key('once-a'),
      })
    );
    // The module returns the existing reversal rather than posting a second.
    const again = await inOrg(ORG_A, (db) =>
      deps.journal.reverseJournalEntry(db, scopeOf(ORG_A), {
        entryId: original.id,
        reason: 'Second reversal',
        at: LATER,
        idempotencyKey: key('once-b'),
      })
    );
    expect(again.reversalReason).toBe('First reversal');

    // And the database refuses a second one written around the module.
    const message = await expectRejection(
      ORG_A,
      (db) =>
        db.$executeRaw`
        INSERT INTO "finance_journal_entries"
          ("id","organizationId","sourceKind","sourceId","description","actorId","occurredAt","idempotencyKey","reversesEntryId","reversalReason")
        VALUES (${key('dup')}, ${ORG_A}, 'PHARMACY_GOODS_RECEIPT', ${original.sourceId},
                'Duplicate reversal', ${ACTOR}, ${LATER}, ${key('dup-idem')}, ${original.id}, 'Again')`
    );
    expect(message).toContain('finance_journal_entries_org_reverses_key');
  });

  it('refuses a "reversal" whose legs are not the exact negation of the original', async () => {
    const original = await postOne('not-a-negation', 2000);
    const message = await expectRejection(ORG_A, async (db) => {
      const entryId = key('fake-reversal');
      await db.$executeRaw`
        INSERT INTO "finance_journal_entries"
          ("id","organizationId","sourceKind","sourceId","description","actorId","occurredAt","idempotencyKey","reversesEntryId","reversalReason")
        VALUES (${entryId}, ${ORG_A}, 'PHARMACY_GOODS_RECEIPT', ${original.sourceId},
                'Not really a reversal', ${ACTOR}, ${LATER}, ${key('fake-idem')}, ${original.id}, 'Shrunk')`;
      // Balanced, but for half the money — a second adjustment wearing a
      // reversal's name.
      await db.$executeRaw`
        INSERT INTO "finance_journal_lines"
          ("id","organizationId","entryId","accountCode","side","amountMinor")
        VALUES (${key('fake-a')}, ${ORG_A}, ${entryId}, 'GOODS_RECEIVED_ACCRUAL', 'DEBIT', 1000)`;
      await db.$executeRaw`
        INSERT INTO "finance_journal_lines"
          ("id","organizationId","entryId","accountCode","side","amountMinor")
        VALUES (${key('fake-b')}, ${ORG_A}, ${entryId}, 'INVENTORY', 'CREDIT', 1000)`;
    });

    expect(message).toContain('FINANCE_REVERSAL_NOT_A_NEGATION');
  });

  it('refuses a reversal that does not say why', async () => {
    const original = await postOne('no-reason');
    const message = await expectRejection(
      ORG_A,
      (db) =>
        db.$executeRaw`
        INSERT INTO "finance_journal_entries"
          ("id","organizationId","sourceKind","sourceId","description","actorId","occurredAt","idempotencyKey","reversesEntryId")
        VALUES (${key('mute')}, ${ORG_A}, 'PHARMACY_GOODS_RECEIPT', ${original.sourceId},
                'Silent reversal', ${ACTOR}, ${LATER}, ${key('mute-idem')}, ${original.id})`
    );
    expect(message).toContain('finance_journal_entries_reversal_reason');
  });
});

describeIfDatabase('finance journal — append-only', () => {
  it('refuses to edit or delete a posted entry or leg', async () => {
    const entry = await inOrg(ORG_A, (db) =>
      deps.journal.postJournalEntry(db, scopeOf(ORG_A), {
        sourceKind: 'PHARMACY_STOCK_WRITE_OFF',
        sourceId: key('src'),
        description: 'Immutable',
        occurredAt: NOW,
        idempotencyKey: key('immutable'),
        lines: balancedLines(4200),
      })
    );
    const leg = entry.lines[0]!;

    const edited = await expectRejection(
      ORG_A,
      (db) =>
        db.$executeRaw`UPDATE "finance_journal_entries" SET "description" = 'Rewritten' WHERE "id" = ${entry.id}`
    );
    expect(edited).toContain('FINANCE_JOURNAL_APPEND_ONLY');

    const repriced = await expectRejection(
      ORG_A,
      (db) =>
        db.$executeRaw`UPDATE "finance_journal_lines" SET "amountMinor" = 1 WHERE "id" = ${leg.id}`
    );
    expect(repriced).toContain('FINANCE_JOURNAL_APPEND_ONLY');

    const deletedLeg = await expectRejection(
      ORG_A,
      (db) => db.$executeRaw`DELETE FROM "finance_journal_lines" WHERE "id" = ${leg.id}`
    );
    expect(deletedLeg).toContain('FINANCE_JOURNAL_APPEND_ONLY');

    const deletedEntry = await expectRejection(
      ORG_A,
      (db) => db.$executeRaw`DELETE FROM "finance_journal_entries" WHERE "id" = ${entry.id}`
    );
    expect(deletedEntry).toContain('FINANCE_JOURNAL_APPEND_ONLY');

    const still = await inOrg(ORG_A, (db) =>
      db.financeJournalEntry.findFirstOrThrow({
        where: { organizationId: ORG_A, id: entry.id },
        include: { lines: true },
      })
    );
    expect(still.description).toBe('Immutable');
    expect(still.lines).toHaveLength(2);
  });
});

describeIfDatabase('finance journal — tenant isolation', () => {
  it('hides one organization’s postings from another', async () => {
    const sourceId = key('tenant-src');
    const entry = await inOrg(ORG_A, (db) =>
      deps.journal.postJournalEntry(db, scopeOf(ORG_A), {
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId,
        description: 'Tenant A only',
        occurredAt: NOW,
        idempotencyKey: key('tenant'),
        lines: balancedLines(999),
      })
    );

    const seenByB = await inOrg(ORG_B, (db) =>
      db.financeJournalEntry.findFirst({ where: { id: entry.id } })
    );
    expect(seenByB).toBeNull();

    const legsSeenByB = await inOrg(ORG_B, (db) =>
      db.financeJournalLine.count({ where: { entryId: entry.id } })
    );
    expect(legsSeenByB).toBe(0);

    const traced = await inOrg(ORG_B, (db) =>
      deps.journal.entriesForSource(db, ORG_B, 'PHARMACY_SALE_LINE', sourceId)
    );
    expect(traced).toHaveLength(0);
  });
});
