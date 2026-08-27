import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  effectiveProgram,
  loyaltyBalance,
  LoyaltyError,
  redeemLoyaltyPoints,
  type RedeemLoyaltyResult,
} from './loyalty';
import { multiply, roundMoney, sub, sum } from './money';

/**
 * M9-L2 — the POS-terminal transport glue over the M8 loyalty contracts.
 *
 * Redemption is CONNECTED-ONLY and never queued: it moves an append-only points ledger and
 * mutates a live bill's `discountTotal`/`grandTotal`, so a pad that replayed it from a local
 * store would double-discount. The command layer (`redeemLoyaltyPoints`) owns every rule —
 * the row locks, the expiry sweep, the balance check, the bill-belongs-to-this-guest check,
 * the redemption-exceeds-bill check and the `loyalty:redeem:<key>` replay record. Nothing is
 * re-implemented here; this file only wires transport, guards the device's branch, and turns
 * Decimals into exact strings.
 *
 * Route factories, the capability gate and the connected-only contract live in
 * `terminal-customers.ts` and are shared, not forked.
 */

// ── Strict input schema ──────────────────────────────────────────────────────

const ID = z.string().min(1);

/**
 * Points are a WHOLE positive count, never money and never a float — the ledger column is a
 * 32-bit integer and the money value is derived server-side from the effective program's
 * `redemptionValue`. A client never sends an amount, so it can never propose its own discount.
 */
export const loyaltyRedeemBody = z
  .object({
    billId: ID,
    accountId: ID,
    points: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

/** The redemption panel's read: one bill, identified by id. Strict — an unknown query
 * parameter is a 400 rather than a silently ignored filter. */
export const loyaltySnapshotQuery = z.object({ billId: ID }).strict();

// ── Domain-error → HTTP shaping (no internals leaked) ────────────────────────

const json = (body: unknown, status: number): NextResponse => NextResponse.json(body, { status });

/**
 * Map a loyalty-domain error onto a status without leaking internals. Everything the cashier
 * can resolve by changing the request is a 409 precondition (not enough points, bill already
 * closed, wrong guest's bill, discount larger than what is still owed, inactive account, no
 * program configured, key reused for a different command); a missing account/bill is a 404;
 * a malformed points/decimal value is a 400. Returns null for a non-domain error so the
 * transport answers a generic 500.
 */
export function loyaltyErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof LoyaltyError)) return null;
  if (err.reason === 'NOT_FOUND') return json({ error: err.message }, 404);
  const conflict =
    err.reason === 'INSUFFICIENT_BALANCE' ||
    err.reason === 'REDEMPTION_EXCEEDS_BILL' ||
    err.reason === 'BILL_NOT_OPEN' ||
    err.reason === 'ACCOUNT_BILL_MISMATCH' ||
    err.reason === 'ACCOUNT_INACTIVE' ||
    err.reason === 'PROGRAM_NOT_CONFIGURED' ||
    err.reason === 'ACTIVE_CUSTOMER_LIMIT_REACHED' ||
    err.reason === 'IDEMPOTENCY_CONFLICT';
  return json({ error: err.message }, conflict ? 409 : 400);
}

// ── Device-scoped read model ─────────────────────────────────────────────────

const money = (value: Prisma.Decimal): string => value.toString();

export type LoyaltySnapshot = {
  billId: string;
  orderId: string;
  billStatus: string;
  customerId: string | null;
  accountId: string | null;
  accountActive: boolean;
  balance: number;
  /** Money per point under the program in force now — the same version a redemption books. */
  redemptionValue: string;
  /** Bill total still uncovered by tenders; a redemption may not exceed it. */
  outstanding: string;
  /** The largest whole point count whose value still fits `outstanding`, capped by balance. */
  maxRedeemablePoints: number;
  /** Loyalty value already redeemed against this bill. */
  redeemedValue: string;
};

/**
 * The program version in force at `at`, or null when the organization has never configured
 * one. Redemption itself is a hard error in that case (`redeemLoyaltyPoints` throws
 * `PROGRAM_NOT_CONFIGURED`), but the READ has to degrade instead of throwing: the panel still
 * needs to render the bill's outstanding balance and say "0 redeemable", not 500 the pad.
 *
 * The lookup is delegated to `loyalty.ts` rather than re-queried here so the preview is priced
 * off EXACTLY the version `redeemLoyaltyPoints` will book against. A second local
 * "which program applies" query would be a second rule to keep in sync, and any drift between
 * them would quote the guest one rate and charge another.
 */
async function currentRedemptionValue(db: ScopedDb, at: Date): Promise<Prisma.Decimal | null> {
  try {
    return (await effectiveProgram(db, at)).redemptionValue;
  } catch (err) {
    if (err instanceof LoyaltyError && err.reason === 'PROGRAM_NOT_CONFIGURED') return null;
    throw err;
  }
}

/**
 * The redemption panel's read model for one bill in the DEVICE'S OWN BRANCH. Returns null
 * outside that branch so a cross-branch or cross-tenant bill id is indistinguishable from
 * "not found" (the M5 `buildReceiptForBranch` rule).
 *
 * `maxRedeemablePoints` is a DISPLAY affordance derived from the same inputs the command
 * uses; it is never trusted as authorization. The server re-derives and re-checks every one
 * of those bounds under row locks inside `redeemLoyaltyPoints`, so a pad that ignores this
 * number still cannot over-redeem. No PII is returned — only the customer/account ids the
 * redemption call needs.
 */
export async function getLoyaltySnapshotForBranch(
  db: ScopedDb,
  billId: string,
  branchId: string,
  at: Date = new Date()
): Promise<LoyaltySnapshot | null> {
  const bill = await db.restaurantBill.findFirst({
    where: { id: billId, branchId },
    select: {
      id: true,
      orderId: true,
      status: true,
      grandTotal: true,
      order: { select: { customerId: true } },
      tenders: { select: { amount: true } },
    },
  });
  if (!bill) return null;

  const outstanding = sub(bill.grandTotal, sum(bill.tenders.map((tender) => tender.amount)));
  const customerId = bill.order.customerId;

  const account = customerId
    ? await db.loyaltyAccount.findUnique({
        where: { customerId },
        select: { id: true, active: true },
      })
    : null;

  // A redemption is stored as NEGATIVE points; the program in force now prices both the
  // preview and the already-redeemed running total.
  const [balance, redeemed, program] = await Promise.all([
    account ? loyaltyBalance(db, account.id) : Promise.resolve(0),
    db.loyaltyPointsEntry.aggregate({
      where: { billId: bill.id, kind: 'REDEEM' },
      _sum: { points: true },
    }),
    currentRedemptionValue(db, at),
  ]);

  const redemptionValue = program ?? new Prisma.Decimal(0);
  const affordable =
    program && program.greaterThan(0)
      ? outstanding.dividedBy(program).toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR).toNumber()
      : 0;

  return {
    billId: bill.id,
    orderId: bill.orderId,
    billStatus: bill.status,
    customerId,
    accountId: account?.id ?? null,
    accountActive: account?.active ?? false,
    balance,
    redemptionValue: money(redemptionValue),
    outstanding: money(outstanding),
    maxRedeemablePoints: Math.max(Math.min(balance, affordable), 0),
    redeemedValue: money(roundMoney(multiply(-(redeemed._sum.points ?? 0), redemptionValue))),
  };
}

// ── Command wiring ───────────────────────────────────────────────────────────

/**
 * Redeem points against a bill in the DEVICE'S OWN BRANCH. The branch guard runs first and
 * returns null outside it; everything else — the account/bill match, the balance floor and the
 * outstanding-balance ceiling — is enforced by the command layer under row locks, inside the
 * transaction the transport already opened.
 */
export async function redeemForBranch(
  db: ScopedDb,
  input: {
    billId: string;
    accountId: string;
    points: number;
    branchId: string;
    actorId: string;
    idempotencyKey: string;
    at: Date;
  }
): Promise<RedeemLoyaltyResult | null> {
  const bill = await db.restaurantBill.findFirst({
    where: { id: input.billId, branchId: input.branchId },
    select: { id: true },
  });
  if (!bill) return null;

  return redeemLoyaltyPoints(db, {
    accountId: input.accountId,
    billId: input.billId,
    points: input.points,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    at: input.at,
  });
}

/** The redemption result for the register: points spent, the money it took off the bill, and
 * the remaining balance — Decimals as exact strings, never floats. */
export function serializeRedeemResult(result: RedeemLoyaltyResult) {
  return {
    entryId: result.entryId,
    accountId: result.accountId,
    billId: result.billId,
    points: result.points,
    value: money(result.value),
    balance: result.balance,
    replayed: result.replayed,
  };
}
