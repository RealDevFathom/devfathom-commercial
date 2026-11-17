/**
 * DEV-748: one card carried through its whole life against a stateful, in-memory ledger: issued,
 * scanned to earn (replay-safe), replaced when lost (the old card stops working, the balance
 * stays), scanned at another branch to earn and redeem, refused in another organization, and
 * finally revoked. The store keeps the database's own rules for cards (one working card per
 * customer, a code hash unique within the organization) so a regression in the domain shows here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({
  customers: [] as Row[],
  consents: [] as Row[],
  cards: [] as Row[],
  sales: [] as Row[],
  tenders: [] as Row[],
  entries: [] as Row[],
  programs: [] as Row[],
  seq: 0,
}));

// The counter's surrounding gates are covered by their own suites; here they always pass.
vi.mock('./regulatory', () => ({ assertStoredPharmacyMayOperate: vi.fn() }));
vi.mock('./rx-sale-gate', () => ({ assertRxSaleAllowed: vi.fn() }));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn() }));
vi.mock('./finance-postings', () => ({ postTenderEntry: vi.fn() }));
vi.mock('./counter-evidence', () => ({ requestCounterEvidence: vi.fn() }));
vi.mock('./consent-writer', () => ({
  // The row lock itself is the database's; the fake only insists the customer is in this tenant.
  lockCustomerConsent: vi.fn(async (_db: unknown, organizationId: string, customerId: string) => {
    if (!store.customers.some((c) => c.organizationId === organizationId && c.id === customerId))
      throw new Error('Customer unavailable in this workspace.');
  }),
}));
vi.mock('./sale-completion', () => ({
  completionSaleInclude: {},
  completePaidPharmacySale: vi.fn(async (_db: unknown, _scope: unknown, sale: Row) => {
    const row = store.sales.find((s) => s.id === sale.id)!;
    row.status = 'COMPLETED';
    return 1;
  }),
}));

import { accrueSalePoints, PharmacyLoyaltyError, redeemSalePoints } from './customer-loyalty';
import { issueLoyaltyCard, linkLoyaltyCardToSale, revokeLoyaltyCard } from './loyalty-card';

/** Prisma-style `where` matching for the operators these paths use. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want === null) return have === null || have === undefined;
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (typeof want === 'object') {
      const op = want as Row;
      if ('not' in op) return have !== op.not;
      if ('in' in op) return (op.in as unknown[]).includes(have);
      if ('lte' in op) return have instanceof Date && have <= (op.lte as Date);
      if ('none' in op) return true;
      return false;
    }
    return have === want;
  });
}

const id = (prefix: string) => `${prefix}-${++store.seq}`;

function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

const db = {
  // Row locks are the database's; the card re-read under lock answers from the store.
  $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
    if (!query.sql.includes('pharmacy_loyalty_cards')) return [];
    const [organizationId, cardId, customerId] = query.values;
    return store.cards
      .filter(
        (c) =>
          c.organizationId === organizationId &&
          c.id === cardId &&
          c.customerId === customerId &&
          !c.revokedAt
      )
      .map((c) => ({ id: c.id }));
  }),
  patientConsent: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const rows = store.consents.filter((c) => matches(c, where));
      return rows.at(-1) ?? null;
    }),
  },
  pharmacyCustomer: {
    findFirst: vi.fn(
      async ({ where }: { where: Row }) => store.customers.find((c) => matches(c, where)) ?? null
    ),
    upsert: vi.fn(
      async ({ where, update }: { where: { organizationId_patientId: Row }; update: Row }) => {
        const existing = store.customers.find((c) => matches(c, where.organizationId_patientId));
        if (!existing) throw new Error('A card scan must never create a customer.');
        Object.assign(existing, update);
        return existing;
      }
    ),
  },
  pharmacyLoyaltyCard: {
    findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
      const card = store.cards.find((c) => matches(c, where));
      if (!card) return null;
      if (select?.customer)
        return {
          id: card.id,
          customer: store.customers.find(
            (c) => c.organizationId === card.organizationId && c.id === card.customerId
          ),
        };
      return { id: card.id, issuedAt: card.issuedAt };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = store.cards.filter((c) => matches(c, where));
      for (const row of rows) {
        // The guard trigger: a revoked card is never changed again.
        if (row.revokedAt) throw new Error('a pharmacy loyalty card can only be revoked once');
        Object.assign(row, data);
      }
      return { count: rows.length };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (!/^[0-9a-f]{64}$/.test(String(data.codeHash))) throw new Error('codeHash check');
      // pharmacy_loyalty_cards_one_active_key and the (organizationId, codeHash) unique key.
      if (
        store.cards.some(
          (c) =>
            c.organizationId === data.organizationId &&
            (c.codeHash === data.codeHash || (c.customerId === data.customerId && !c.revokedAt))
        )
      )
        throw uniqueViolation();
      const row = { id: id('card'), issuedAt: new Date(), revokedAt: null, ...data };
      store.cards.push(row);
      return { id: row.id, issuedAt: row.issuedAt };
    }),
  },
  pharmacySale: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const sale = store.sales.find((s) => matches(s, where));
      if (!sale) return null;
      return { ...sale, tenders: store.tenders.filter((t) => t.saleId === sale.id) };
    }),
    update: vi.fn(async ({ where, data }: { where: { organizationId_id: Row }; data: Row }) => {
      const sale = store.sales.find((s) => matches(s, where.organizationId_id))!;
      Object.assign(sale, data);
      return sale;
    }),
  },
  pharmacySaleLine: { findFirst: vi.fn(async () => null) },
  pharmacyLoyaltyProgramVersion: {
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        store.programs.filter((p) => matches(p, where)).at(-1) ?? null
    ),
  },
  pharmacyTender: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: id('tender'), createdAt: new Date(), ...data };
      store.tenders.push(row);
      return row;
    }),
  },
  pharmacyLoyaltyPointsEntry: {
    findUnique: vi.fn(async ({ where }: { where: { organizationId_idempotencyKey: Row } }) => {
      const entry = store.entries.find((e) => matches(e, where.organizationId_idempotencyKey));
      if (!entry) return null;
      return { ...entry, tender: store.tenders.find((t) => t.id === entry.tenderId) ?? null };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (store.entries.some((e) => e.idempotencyKey === data.idempotencyKey))
        throw uniqueViolation();
      const row = { id: id('entry'), ...data };
      store.entries.push(row);
      return row;
    }),
    aggregate: vi.fn(async ({ where }: { where: Row }) => ({
      _sum: {
        points: store.entries
          .filter((e) => matches(e, where))
          .reduce((sum, e) => sum + Number(e.points), 0),
      },
    })),
    count: vi.fn(
      async ({ where }: { where: Row }) => store.entries.filter((e) => matches(e, where)).length
    ),
  },
};

const ORG = 'org-a';
const owner = { organizationId: ORG, actorId: 'owner-a' };
const branchA = { organizationId: ORG, branchId: 'branch-a', actorId: 'cashier-a' };
const branchB = { organizationId: ORG, branchId: 'branch-b', actorId: 'cashier-b' };
const otherOrg = { organizationId: 'org-b', branchId: 'branch-z', actorId: 'cashier-z' };

function openSale(scope: { organizationId: string; branchId: string }, grossMinor: number) {
  const sale = {
    id: id('sale'),
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    status: 'OPEN',
    customerId: null as string | null,
    lines: [
      {
        grossMinor,
        discountMinor: 0,
        medicine: { rx: false, restricted: false, controlled: false },
      },
    ],
  };
  store.sales.push(sale);
  return sale;
}

function payCash(sale: { id: string; organizationId: string; branchId: string }, amount: number) {
  store.tenders.push({
    id: id('tender'),
    organizationId: sale.organizationId,
    branchId: sale.branchId,
    saleId: sale.id,
    type: 'CASH',
    amountMinor: amount,
  });
  store.sales.find((s) => s.id === sale.id)!.status = 'COMPLETED';
}

function balance(branchId: string, customerId = 'customer-a') {
  return store.entries
    .filter(
      (e) => e.organizationId === ORG && e.branchId === branchId && e.customerId === customerId
    )
    .reduce((sum, e) => sum + Number(e.points), 0);
}

const notRecognised = new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED');

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(store, {
    customers: [
      {
        id: 'customer-a',
        organizationId: ORG,
        patientId: 'patient-a',
        displayName: 'Ayesha',
        phoneLast4: '1234',
        active: true,
      },
      // Another organization's customer; its card must never resolve inside org-a.
      {
        id: 'customer-z',
        organizationId: 'org-b',
        patientId: 'patient-z',
        displayName: 'Zara',
        phoneLast4: '9876',
        active: true,
      },
    ],
    consents: [
      {
        organizationId: ORG,
        patientId: 'patient-a',
        purpose: 'LOYALTY',
        granted: true,
        revokedAt: null,
      },
      {
        organizationId: 'org-b',
        patientId: 'patient-z',
        purpose: 'LOYALTY',
        granted: true,
        revokedAt: null,
      },
    ],
    cards: [],
    sales: [],
    tenders: [],
    entries: [],
    // One point per PKR 1 spent; one point redeems for PKR 1.
    programs: [
      {
        id: 'program-a',
        organizationId: ORG,
        version: 1,
        earnMode: 'POINTS_PER_SPEND_STEP',
        earnPoints: 1,
        perSpendMinor: 100,
        redemptionValueMinor: 100,
        expiryDays: null,
      },
    ],
    seq: 0,
  });
});

describe('DEV-748 a loyalty card through its whole life', () => {
  it('issues, earns once, survives replacement, works at another branch and redeems', async () => {
    // Issued from the loyalty console.
    const first = await issueLoyaltyCard(db as never, owner, { customerId: 'customer-a' });
    expect(store.cards).toHaveLength(1);
    expect(JSON.stringify(store.cards)).not.toContain(first.code);

    // Scanned at branch A: the bill is linked, and paying it earns points exactly once.
    const saleA1 = openSale(branchA, 50_000);
    await expect(
      linkLoyaltyCardToSale(db as never, branchA, { saleId: saleA1.id, code: first.code })
    ).resolves.toMatchObject({ customerId: 'customer-a', cardId: first.card.id });
    expect(saleA1.customerId).toBe('customer-a');
    payCash(saleA1, 50_000);
    await expect(accrueSalePoints(db as never, branchA, saleA1.id)).resolves.toMatchObject({
      points: 500,
      replayed: false,
    });
    await expect(accrueSalePoints(db as never, branchA, saleA1.id)).resolves.toMatchObject({
      points: 500,
      replayed: true,
    });
    expect(balance('branch-a')).toBe(500);

    // Lost: replacing it needs a reason and revokes the old card in the same step.
    await expect(
      issueLoyaltyCard(db as never, owner, { customerId: 'customer-a' })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CARD_REASON_REQUIRED'));
    const second = await issueLoyaltyCard(db as never, owner, {
      customerId: 'customer-a',
      reason: 'Card lost',
    });
    expect(second.code).not.toBe(first.code);
    expect(second.replacedCardId).toBe(first.card.id);
    expect(store.cards.filter((c) => !c.revokedAt)).toEqual([
      expect.objectContaining({ id: second.card.id, customerId: 'customer-a' }),
    ]);

    // The old card stops working at once, and leaves the bill untouched.
    const saleA2 = openSale(branchA, 30_000);
    await expect(
      linkLoyaltyCardToSale(db as never, branchA, { saleId: saleA2.id, code: first.code })
    ).rejects.toEqual(notRecognised);
    expect(saleA2.customerId).toBeNull();
    // The points belong to the customer, not the card: the balance is kept.
    expect(balance('branch-a')).toBe(500);

    // The replacement links at branch A and redeems the kept balance.
    await linkLoyaltyCardToSale(db as never, branchA, { saleId: saleA2.id, code: second.code });
    expect(saleA2.customerId).toBe('customer-a');
    await expect(
      redeemSalePoints(db as never, branchA, {
        saleId: saleA2.id,
        points: 200,
        deviceId: 'till-a',
        businessDate: new Date('2026-11-17T00:00:00Z'),
        idempotencyKey: 'redeem-a2',
      })
    ).resolves.toMatchObject({ points: 200, amountMinor: 20_000, settled: false });
    expect(balance('branch-a')).toBe(300);

    // The same card is recognised at another branch of the organization: it earns there,
    // replay-safely, and redeems there.
    const saleB1 = openSale(branchB, 20_000);
    await linkLoyaltyCardToSale(db as never, branchB, { saleId: saleB1.id, code: second.code });
    expect(saleB1.customerId).toBe('customer-a');
    payCash(saleB1, 20_000);
    await accrueSalePoints(db as never, branchB, saleB1.id);
    await expect(accrueSalePoints(db as never, branchB, saleB1.id)).resolves.toMatchObject({
      replayed: true,
    });
    expect(balance('branch-b')).toBe(200);
    const saleB2 = openSale(branchB, 5_000);
    await linkLoyaltyCardToSale(db as never, branchB, { saleId: saleB2.id, code: second.code });
    await expect(
      redeemSalePoints(db as never, branchB, {
        saleId: saleB2.id,
        points: 50,
        deviceId: 'till-b',
        businessDate: new Date('2026-11-17T00:00:00Z'),
        idempotencyKey: 'redeem-b2',
      })
    ).resolves.toMatchObject({ points: 50, amountMinor: 5_000, settled: true });
    // A bill paid wholly in points earns nothing more.
    expect(balance('branch-b')).toBe(150);
    expect(store.entries.filter((e) => e.kind === 'EARN')).toHaveLength(2);

    // Revoked without a replacement: it no longer works anywhere.
    await revokeLoyaltyCard(db as never, owner, { customerId: 'customer-a', reason: 'Stolen' });
    const saleA3 = openSale(branchA, 1_000);
    await expect(
      linkLoyaltyCardToSale(db as never, branchA, { saleId: saleA3.id, code: second.code })
    ).rejects.toEqual(notRecognised);
    expect(saleA3.customerId).toBeNull();
    expect(balance('branch-a')).toBe(300);
  });

  it('never resolves a card in another organization, in either direction', async () => {
    const mine = await issueLoyaltyCard(db as never, owner, { customerId: 'customer-a' });
    const theirs = await issueLoyaltyCard(
      db as never,
      { organizationId: 'org-b', actorId: 'owner-z' },
      { customerId: 'customer-z' }
    );

    const foreignSale = openSale(otherOrg, 10_000);
    await expect(
      linkLoyaltyCardToSale(db as never, otherOrg, { saleId: foreignSale.id, code: mine.code })
    ).rejects.toEqual(notRecognised);
    expect(foreignSale.customerId).toBeNull();

    const ownSale = openSale(branchA, 10_000);
    await expect(
      linkLoyaltyCardToSale(db as never, branchA, { saleId: ownSale.id, code: theirs.code })
    ).rejects.toEqual(notRecognised);
    expect(ownSale.customerId).toBeNull();

    // Each still works in its own organization.
    await linkLoyaltyCardToSale(db as never, otherOrg, {
      saleId: foreignSale.id,
      code: theirs.code,
    });
    expect(foreignSale.customerId).toBe('customer-z');
    // A customer of another organization cannot be issued a card here either.
    await expect(
      issueLoyaltyCard(db as never, owner, { customerId: 'customer-z' })
    ).rejects.toEqual(new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND'));
  });

  it('refuses a scan whose card is revoked between its lookup and the link', async () => {
    const card = await issueLoyaltyCard(db as never, owner, { customerId: 'customer-a' });
    const sale = openSale(branchA, 10_000);
    // The manager's revoke commits after the scan read the card, before it took the locks.
    const lookup = db.pharmacyLoyaltyCard.findFirst.getMockImplementation()!;
    db.pharmacyLoyaltyCard.findFirst.mockImplementationOnce(async (args) => {
      const found = await lookup(args);
      await revokeLoyaltyCard(db as never, owner, { customerId: 'customer-a', reason: 'Stolen' });
      return found;
    });
    await expect(
      linkLoyaltyCardToSale(db as never, branchA, { saleId: sale.id, code: card.code })
    ).rejects.toEqual(notRecognised);
    expect(sale.customerId).toBeNull();
  });

  it('stops a card working once its holder withdraws loyalty consent', async () => {
    const card = await issueLoyaltyCard(db as never, owner, { customerId: 'customer-a' });
    store.consents.push({
      organizationId: ORG,
      patientId: 'patient-a',
      purpose: 'LOYALTY',
      granted: false,
      revokedAt: new Date(),
    });
    const sale = openSale(branchA, 10_000);
    await expect(
      linkLoyaltyCardToSale(db as never, branchA, { saleId: sale.id, code: card.code })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    expect(sale.customerId).toBeNull();
  });
});
