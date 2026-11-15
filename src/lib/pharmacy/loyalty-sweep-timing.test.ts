import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(async () => undefined) }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: vi.fn(), withTenantDb: vi.fn() }));

import { restoreRefundedLoyaltyPoints } from './customer-loyalty';
import { reverseRefundedEarnedPoints } from './customer-loyalty-earned-reversal';
import { expireCustomerLoyaltyPoints, pointsPastExpiry } from './loyalty-expiry';

/**
 * DEV-764: when the expiry sweep runs must never change a decision or a balance. These drive
 * the real reversal, refund-restoration and sweep code against an in-memory ledger, once with
 * the sweep run early and once with it run late, and compare the outcome.
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'manager-a' };
const customer = { ...scope, customerId: 'customer-a' };
// 1 point for every PKR 1 collected on khata.
const khataRule = {
  id: 'rule-k',
  earnMode: 'POINTS_PER_SPEND_STEP',
  earnPoints: 1,
  perSpendMinor: 100,
};

function world() {
  const entries: Row[] = [];
  const refunds: Row[] = [];
  const tenders = new Map<string, Row>();
  let seq = 0;
  const closedBy = (id: string) =>
    entries
      .filter((e) => e.kind === 'EXPIRY' && e.reversesEntryId === id)
      .map((e) => ({ points: e.points }));
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === 'kind')
        return typeof value === 'string' ? row.kind === value : value.in.includes(row.kind);
      if (key === 'occurredAt') return row.occurredAt.getTime() <= value.lte.getTime();
      if (key === 'expiresAt')
        return row.expiresAt !== null && row.expiresAt.getTime() <= value.lte.getTime();
      if (key === 'closedBy') return closedBy(row.id).length === 0;
      if (key === 'reverses') {
        const target = entries.find((e) => e.id === row.reversesEntryId);
        return Boolean(target) && value.is.kind.in.includes(target!.kind);
      }
      if (key === 'tender') return tenders.get(row.tenderId)?.type !== value.type.not;
      return row[key] === value;
    });
  const decorate = (row: Row) => ({
    ...row,
    closedBy: closedBy(row.id),
    tender: row.tenderId ? tenders.get(row.tenderId) : null,
    programVersion: row.programVersionId ? khataRule : null,
  });
  const refundMatches = (refund: Row, where: Row) => {
    if (where.originalTenderId) return refund.originalTenderId === where.originalTenderId;
    if (refund.saleId !== where.saleId) return false;
    const type = tenders.get(refund.originalTenderId)!.type;
    const rule = where.originalTender.type;
    return rule.notIn ? !rule.notIn.includes(type) : type !== rule.not;
  };
  const db = {
    $queryRaw: vi.fn(async () => []),
    pharmacyLoyaltyPointsEntry: {
      findUnique: vi.fn(
        async ({ where }: Row) =>
          entries.find(
            (e) => e.idempotencyKey === where.organizationId_idempotencyKey.idempotencyKey
          ) ?? null
      ),
      findFirst: vi.fn(async ({ where }: Row) => {
        const row = entries.find((e) => matches(e, where));
        return row ? decorate(row) : null;
      }),
      findMany: vi.fn(async ({ where, orderBy }: Row) => {
        const rows = entries.filter((e) => matches(e, where)).map(decorate);
        if (JSON.stringify(orderBy ?? '').includes('earnStartMinor'))
          rows.sort((a, b) => a.earnStartMinor - b.earnStartMinor || a.id.localeCompare(b.id));
        return rows;
      }),
      aggregate: vi.fn(async ({ where }: Row) => {
        const rows = entries.filter((e) => matches(e, where));
        return {
          _sum: { points: rows.length ? rows.reduce((sum, e) => sum + e.points, 0) : null },
        };
      }),
      count: vi.fn(async ({ where }: Row) => entries.filter((e) => matches(e, where)).length),
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          id: `e${String(seq++).padStart(4, '0')}`,
          saleId: null,
          tenderId: null,
          refundId: null,
          programVersionId: null,
          reversesEntryId: null,
          expiresAt: null,
          earnStartMinor: null,
          occurredAt: new Date(),
          ...data,
        };
        entries.push(row);
        return row;
      }),
    },
    pharmacyRefund: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const refund = refunds.find((r) => r.id === where.id);
        return refund
          ? {
              ...refund,
              originalTender: tenders.get(refund.originalTenderId),
              sale: { customerId: 'customer-a' },
            }
          : null;
      }),
      aggregate: vi.fn(async ({ where }: Row) => ({
        _sum: {
          amountMinor: refunds
            .filter((r) => refundMatches(r, where))
            .reduce((s, r) => s + r.amountMinor, 0),
        },
      })),
    },
    pharmacyLoyaltyProgramVersion: { findFirst: vi.fn(async () => khataRule) },
  };
  const at = (when: Date) => vi.setSystemTime(when);
  const base = {
    organizationId: 'org-a',
    branchId: 'branch-a',
    customerId: 'customer-a',
    actorId: 'actor',
  };

  return {
    db,
    entries,
    balance: () => entries.reduce((sum, e) => sum + e.points, 0),
    sweep: (when: Date) => (at(when), expireCustomerLoyaltyPoints(db as never, customer, when)),
    /** A cash sale that earned at PKR 1 a point (the pre-versioning curve), expiring after 30 days. */
    async earn(when: Date, sale: string, points: number) {
      at(when);
      tenders.set(`cash-${sale}`, {
        id: `cash-${sale}`,
        type: 'CASH',
        saleId: sale,
        branchId: 'branch-a',
        amountMinor: points * 100,
      });
      await db.pharmacyLoyaltyPointsEntry.create({
        data: {
          ...base,
          saleId: sale,
          kind: 'EARN',
          points,
          netPaidMinor: points * 100,
          expiresAt: new Date(when.getTime() + 30 * DAY),
          idempotencyKey: `earn:${sale}`,
        },
      });
    },
    /** A khata collection of `points` rupees on a credit sale, earning 1 point per rupee. */
    async khataEarn(when: Date, sale: string, points: number) {
      at(when);
      tenders.set(`credit-${sale}`, {
        id: `credit-${sale}`,
        type: 'CREDIT',
        saleId: sale,
        branchId: 'branch-a',
        amountMinor: points * 100,
      });
      await db.pharmacyLoyaltyPointsEntry.create({
        data: {
          ...base,
          saleId: sale,
          tenderId: `credit-${sale}`,
          kind: 'KHATA_EARN',
          points,
          netPaidMinor: points * 100,
          earnStartMinor: 0,
          programVersionId: 'rule-k',
          expiresAt: new Date(when.getTime() + 30 * DAY),
          idempotencyKey: `khata:${sale}`,
        },
      });
    },
    async redeem(when: Date, tender: string, points: number) {
      at(when);
      tenders.set(tender, {
        id: tender,
        type: 'LOYALTY',
        saleId: `sale-${tender}`,
        branchId: 'branch-a',
        amountMinor: points * 100,
      });
      await db.pharmacyLoyaltyPointsEntry.create({
        data: {
          ...base,
          saleId: `sale-${tender}`,
          tenderId: tender,
          kind: 'REDEEM',
          points: -points,
          requestedPoints: points,
          idempotencyKey: `redeem:${tender}`,
        },
      });
    },
    async spendable(when: Date) {
      at(when);
      return (
        entries.reduce((sum, e) => sum + e.points, 0) -
        (await pointsPastExpiry(db as never, customer, when))
      );
    },
    async refundRedemption(when: Date, tender: string, amountMinor: number) {
      at(when);
      const id = `refund-${refunds.length}`;
      refunds.push({ id, saleId: `sale-${tender}`, originalTenderId: tender, amountMinor });
      await restoreRefundedLoyaltyPoints(db as never, scope, {
        refundId: id,
        tenderId: tender,
        saleId: `sale-${tender}`,
        customerId: 'customer-a',
      });
    },
    async reverse(
      when: Date,
      sale: string,
      amountMinor: number,
      tenderType: 'cash' | 'credit' = 'cash'
    ) {
      at(when);
      const id = `refund-${refunds.length}`;
      refunds.push({ id, saleId: sale, originalTenderId: `${tenderType}-${sale}`, amountMinor });
      await reverseRefundedEarnedPoints(db as never, scope, id);
    },
  };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('DEV-764 sweep timing never changes a refund reversal', () => {
  async function sequence(sweepEarly: boolean, khata: boolean) {
    const w = world();
    // Earn 36 (expires day 31), refund 7 of it, redeem 23, [sweep], refund 3 of the redemption,
    // refund 17 more of the earning sale, sweep.
    if (khata) await w.khataEarn(day(1), 'sale-e', 36);
    else await w.earn(day(1), 'sale-e', 36);
    await w.reverse(day(2), 'sale-e', 700, khata ? 'credit' : 'cash');
    await w.redeem(day(20), 'points-1', 23);
    if (sweepEarly) await w.sweep(day(32));
    await w.refundRedemption(day(33), 'points-1', 300);
    await w.reverse(day(34), 'sale-e', 1_700, khata ? 'credit' : 'cash');
    await w.sweep(day(40));
    return w.balance();
  }

  it.each([false, true])(
    'gives the same final balance whenever the sweep ran (khata: %s)',
    async (khata) => {
      const early = await sequence(true, khata);
      const late = await sequence(false, khata);
      expect(early).toBe(late);
      expect(late).toBe(-8);
    }
  );

  it('gives the same decisions and final balance with the sweep before every step or once at the end', async () => {
    let seed = 7;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = (n: number) => Math.floor(random() * n);
    for (let run = 0; run < 300; run += 1) {
      const script = Array.from({ length: 20 }, () => ({
        op: pick(5),
        a: pick(1_000),
        b: pick(1_000),
      }));
      const play = async (sweepEveryStep: boolean) => {
        const w = world();
        const decisions: string[] = [];
        const sales: Array<{ sale: string; points: number; refunded: number }> = [];
        const redemptions: Array<{ tender: string; points: number; refunded: number }> = [];
        let today = 1;
        for (const [index, step] of script.entries()) {
          today += step.op === 4 ? 5 + (step.a % 30) : 1;
          const now = day(today);
          if (sweepEveryStep) await w.sweep(now);
          if (step.op === 0) {
            const sale = `sale-${index}`;
            const points = 5 + (step.a % 60);
            await w.earn(now, sale, points);
            sales.push({ sale, points, refunded: 0 });
          } else if (step.op === 1) {
            const want = 1 + (step.a % 40);
            const ok = (await w.spendable(now)) >= want;
            decisions.push(`redeem ${want} ${ok}`);
            if (ok) {
              const tender = `points-${index}`;
              await w.redeem(now, tender, want);
              redemptions.push({ tender, points: want, refunded: 0 });
            }
          } else if (step.op === 2 && redemptions.length) {
            const r = redemptions[step.a % redemptions.length]!;
            const left = r.points * 100 - r.refunded;
            if (left > 0) {
              const amount = 100 * (1 + (step.b % Math.ceil(left / 100)));
              const take = Math.min(left, amount);
              r.refunded += take;
              await w.refundRedemption(now, r.tender, take);
            }
          } else if (step.op === 3 && sales.length) {
            const s = sales[step.a % sales.length]!;
            const left = s.points * 100 - s.refunded;
            if (left > 0) {
              const take = Math.min(left, 100 * (1 + (step.b % Math.ceil(left / 100))));
              s.refunded += take;
              await w.reverse(now, s.sale, take);
            }
          }
        }
        await w.sweep(day(today + 60));
        return { decisions, balance: w.balance() };
      };
      const every = await play(true);
      const once = await play(false);
      expect({ run, ...every }).toEqual({ run, ...once });
    }
  }, 60_000);
});
