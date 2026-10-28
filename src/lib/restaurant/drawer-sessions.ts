import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { POS_CONCURRENT_REGISTERS_LIMIT, resolveEntitlementLimit } from '@/lib/entitlement-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate, resolveBusinessDate } from './business-date';
import { buildAuthenticatedCoAuthorizationRecord } from './co-authorization';
import { add, isNegative, money, sub, ZERO } from './money';

/**
 * M5-L3 / C8 — the drawer-session command layer + the append-only drawer ledger.
 *
 * A drawer session ties a register (device) × operator × business date. At most
 * one session per register is OPEN at a time (a DB partial unique,
 * `restaurant_drawer_sessions_device_open_key`, is the concurrency backstop; the
 * commands also pre-check for a friendly error). Cash accountability is the
 * append-only movement ledger (`RestaurantDrawerMovement`, C3 — SELECT+INSERT RLS
 * only): opening float, cash sales/refunds (written by L4's tender/refund flow in
 * the SAME transaction via `appendMovement`), manual paid-in/paid-out/drop
 * adjustments, and the closing count. `expectedCash` is DERIVED — never stored on
 * a movement — by folding the ledger; close records the counted cash and the
 * variance once (the session row legitimately transitions OPEN→CLOSED, so it keeps
 * UPDATE, but its counts are written exactly once).
 *
 * Every top-level command runs in one tenant-scoped interactive transaction and
 * honours a device-scoped idempotency key in `restaurant_money_idempotency_keys`
 * (C11 — a SEPARATE replay domain from the M4 order keys): a replay of the same
 * (deviceId, key) returns the original result and creates nothing. `appendMovement`
 * is the low-level within-transaction primitive L4 composes into its own
 * idempotent tender/refund commands, so it takes a live `tx` and does no
 * idempotency of its own. Capability gating (`cash:open`/`cash:adjust`/`cash:close`,
 * C11) lives at the terminal REST edge (L5); this layer validates and persists.
 *
 * Server time is authoritative (C6): callers pass the server instant as `now`.
 * Money is Prisma.Decimal throughout via `money.ts` (C2) — no float ever touches a
 * drawer amount, and movement magnitudes are non-negative (the DB CHECK enforces
 * it; the fold applies the sign by kind).
 */

export type DrawerSessionErrorReason =
  | 'BRANCH_NOT_FOUND'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_BRANCH_MISMATCH'
  | 'DRAWER_NOT_FOUND'
  | 'DRAWER_NOT_OPEN'
  | 'DRAWER_ALREADY_OPEN'
  | 'ALREADY_CLOSED'
  | 'NEGATIVE_AMOUNT'
  | 'REASON_REQUIRED'
  | 'LIMIT_REACHED'
  | 'LIMIT_UNAVAILABLE'
  | 'INVALID';

export class DrawerSessionError extends Error {
  constructor(
    message: string,
    readonly reason: DrawerSessionErrorReason
  ) {
    super(message);
    this.name = 'DrawerSessionError';
  }
}

export type DrawerMovementKind =
  'OPENING_FLOAT' | 'CASH_SALE' | 'CASH_REFUND' | 'PAID_IN' | 'PAID_OUT' | 'DROP' | 'CLOSING_COUNT';

/** The manual adjustment kinds a `cash:adjust` command may post (C8). Opening
 * float, sales, refunds and the closing count are written by their own commands /
 * by L4, never by the adjustment command. */
export type DrawerAdjustmentKind = 'PAID_IN' | 'PAID_OUT' | 'DROP';

/** Who/what is issuing a money command + the device-scoped idempotency key
 * (C6/C11). Mirrors the M4 order actor shape but writes the SEPARATE money key
 * table so the two replay domains never collide. */
export type MoneyActor = {
  staffProfileId: string;
  deviceId: string;
  idempotencyKey: string;
};

// ── Shared money-command plumbing (reused by daily-close.ts) ──────────────────

/**
 * Open one tenant-scoped interactive transaction. `db` is the request's
 * `createTenantDb` proxy whose `$transaction` sets the RLS tenant GUC and hands
 * the callback a nested `ScopedDb`; Prisma types the callback param as the
 * interactive-transaction client, so we retype it to the `ScopedDb` the proxy
 * actually passes at runtime (same shape as `orders.ts`).
 */
export function runMoneyTransaction<T>(
  db: ScopedDb,
  work: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

export type CanonicalMoneyPayload = {
  /** The exact canonical UTF-8 request bytes used to produce `hash`. */
  bytes: string;
  /** Lowercase SHA-256 of `bytes`. */
  hash: string;
};

export type IdempotencyOutcome =
  | { replay: false }
  | {
      replay: true;
      resultRef: string | null;
      /** Present for canonical (version 1) commands; omitted for legacy version-0 rows. */
      resultPayload?: Prisma.JsonValue | null;
    };

export class MoneyIdempotencyError extends Error {
  readonly reason = 'TAX_SETTLEMENT_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MoneyIdempotencyError';
  }
}

function requireCanonicalHash(payload: CanonicalMoneyPayload): string {
  const calculated = createHash('sha256').update(payload.bytes, 'utf8').digest('hex');
  if (payload.hash !== calculated) {
    throw new MoneyIdempotencyError('The canonical money payload hash does not match its bytes.');
  }
  return calculated;
}

/**
 * Begin an idempotent money command against `restaurant_money_idempotency_keys`.
 * If this (deviceId, key) already ran, returns a replay with the stored result
 * reference (the caller re-reads and returns the original, creating nothing);
 * otherwise records the key and proceeds. A concurrent duplicate that loses the
 * unique-index race rolls the whole transaction back (fail-closed) and the retry
 * observes the committed key and replays.
 */
export async function beginMoneyIdempotent(
  tx: ScopedDb,
  actor: MoneyActor,
  commandType: string,
  canonicalPayload?: CanonicalMoneyPayload
): Promise<IdempotencyOutcome> {
  const canonicalPayloadHash = canonicalPayload ? requireCanonicalHash(canonicalPayload) : null;
  const existing = await tx.restaurantMoneyIdempotencyKey.findUnique({
    where: { deviceId_key: { deviceId: actor.deviceId, key: actor.idempotencyKey } },
    select: {
      commandType: true,
      canonicalPayloadHash: true,
      resultRef: true,
      resultPayload: true,
      completedAt: true,
    },
  });
  if (existing) {
    if (existing.commandType !== commandType) {
      throw new MoneyIdempotencyError(
        'This idempotency key is already bound to a different canonical money payload.'
      );
    }
    if (
      canonicalPayloadHash !== null &&
      (existing.canonicalPayloadHash !== canonicalPayloadHash || existing.completedAt === null)
    ) {
      throw new MoneyIdempotencyError(
        'This idempotency key is already bound to a different canonical money payload.'
      );
    }
    if (existing.canonicalPayloadHash === null) {
      return { replay: true, resultRef: existing.resultRef };
    }
    return { replay: true, resultRef: existing.resultRef, resultPayload: existing.resultPayload };
  }
  await tx.restaurantMoneyIdempotencyKey.create({
    data: {
      deviceId: actor.deviceId,
      key: actor.idempotencyKey,
      commandType,
      canonicalPayloadHash,
    },
  });
  return { replay: false };
}

/** Record what a first-run money command produced, so a later replay returns it. */
export async function recordMoneyResult(
  tx: ScopedDb,
  actor: MoneyActor,
  resultRef: string,
  resultPayload?: Prisma.InputJsonValue,
  completedAt: Date = new Date()
): Promise<void> {
  const finalized = await tx.restaurantMoneyIdempotencyKey.updateMany({
    where: {
      deviceId: actor.deviceId,
      key: actor.idempotencyKey,
      resultRef: null,
      resultPayload: { equals: Prisma.DbNull },
      completedAt: null,
    },
    data: resultPayload === undefined ? { resultRef } : { resultRef, resultPayload, completedAt },
  });
  if (finalized.count !== 1) {
    throw new MoneyIdempotencyError('This money idempotency result has already been finalized.');
  }
}

/** Validate + persist a co-authorization record and return its id (mirrors
 * `orders.ts`). The invariants (distinct approver, non-empty reason) live in
 * `co-authorization.ts`; `organizationId`/`createdAt` come from the DB. */
export async function persistCoAuth(
  tx: ScopedDb,
  request: Parameters<typeof buildAuthenticatedCoAuthorizationRecord>[1]
): Promise<string> {
  const record = await buildAuthenticatedCoAuthorizationRecord(tx, request);
  const row = await tx.restaurantCoAuthorization.create({ data: record, select: { id: true } });
  return row.id;
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new DrawerSessionError('This command requires a non-empty reason.', 'REASON_REQUIRED');
  }
  return trimmed;
}

function requireNonNegative(value: Prisma.Decimal, label: string): Prisma.Decimal {
  if (isNegative(value)) {
    throw new DrawerSessionError(`${label} must not be negative.`, 'NEGATIVE_AMOUNT');
  }
  return value;
}

// ── Expected-cash fold (C8 — the pure ledger derivation) ──────────────────────

/** The signed contribution of each movement kind to a drawer's expected cash.
 * OPENING_FLOAT/CASH_SALE/PAID_IN add; CASH_REFUND/PAID_OUT/DROP remove;
 * CLOSING_COUNT is the physical count, NOT part of the expectation, so it folds to
 * zero. Kept in one place so `expectedCash` and the daily close never diverge. */
const MOVEMENT_SIGN: Record<DrawerMovementKind, -1 | 0 | 1> = {
  OPENING_FLOAT: 1,
  CASH_SALE: 1,
  PAID_IN: 1,
  CASH_REFUND: -1,
  PAID_OUT: -1,
  DROP: -1,
  CLOSING_COUNT: 0,
};

export type FoldableMovement = { kind: DrawerMovementKind; amount: Prisma.Decimal | string };

/**
 * Fold the movement ledger into the expected cash a drawer should hold: opening
 * float + cash sales − cash refunds + paid-ins − paid-outs − drops (the closing
 * count is excluded). PURE and exact — Decimal arithmetic only (C2), so
 * `expectedCash` equals this fold to the cent every time.
 */
export function foldExpectedCash(movements: readonly FoldableMovement[]): Prisma.Decimal {
  return movements.reduce<Prisma.Decimal>((total, movement) => {
    const sign = MOVEMENT_SIGN[movement.kind];
    if (sign === 0) return total;
    const amount = money(movement.amount);
    return sign === 1 ? add(total, amount) : sub(total, amount);
  }, ZERO);
}

// ── Append a movement (low-level, within an existing transaction) ─────────────

export type AppendMovementInput = {
  drawerSessionId: string;
  kind: DrawerMovementKind;
  /** Non-negative magnitude; the sign is applied by kind in the fold (C8). */
  amount: Prisma.Decimal | string;
  reason?: string | null;
  /** The money record that produced this movement (L4 links the tender/refund). */
  tenderId?: string | null;
  refundId?: string | null;
  staffProfileId: string;
  deviceId: string;
};

/**
 * Append one movement to an OPEN drawer's ledger and return its id. The primitive
 * L4's cash tender/refund flow calls INSIDE its own idempotent transaction (for
 * CASH_SALE/CASH_REFUND), and the drawer commands here call for
 * OPENING_FLOAT/adjustments/CLOSING_COUNT. It asserts the session exists and is
 * OPEN (a movement on a closed drawer is a bug) and rejects a negative magnitude;
 * it performs no idempotency of its own — the caller's command owns that.
 */
export async function appendMovement(
  tx: ScopedDb,
  input: AppendMovementInput
): Promise<{ movementId: string }> {
  await tx.$queryRaw`SELECT id FROM restaurant_drawer_sessions WHERE id = ${input.drawerSessionId} FOR UPDATE`;
  const session = await tx.restaurantDrawerSession.findUnique({
    where: { id: input.drawerSessionId },
    select: { id: true, status: true },
  });
  if (!session) {
    throw new DrawerSessionError('The drawer session does not exist.', 'DRAWER_NOT_FOUND');
  }
  if (session.status !== 'OPEN') {
    throw new DrawerSessionError(
      'The drawer session is closed; no further movements can be posted.',
      'DRAWER_NOT_OPEN'
    );
  }
  const amount = requireNonNegative(money(input.amount), 'A drawer movement amount');
  const movement = await tx.restaurantDrawerMovement.create({
    data: {
      drawerSessionId: session.id,
      kind: input.kind,
      amount,
      reason: input.reason?.trim() || null,
      tenderId: input.tenderId ?? null,
      refundId: input.refundId ?? null,
      staffProfileId: input.staffProfileId,
      deviceId: input.deviceId,
    },
    select: { id: true },
  });
  return { movementId: movement.id };
}

// ── Open ──────────────────────────────────────────────────────────────────────

export type OpenDrawerSessionInput = {
  organizationId: string;
  entitlementLimits: Readonly<Record<string, number>>;
  branchId: string;
  openingFloat: Prisma.Decimal | string;
  actor: MoneyActor;
  /** Authoritative server instant (C6). Defaults to now. */
  now?: Date;
};

export type OpenDrawerSessionResult = {
  drawerSessionId: string;
  businessDate: Date;
  openingFloat: Prisma.Decimal;
  replayed: boolean;
};

export type CurrentDrawerSessionResult = {
  drawerSessionId: string;
  businessDate: Date;
  openingFloat: Prisma.Decimal;
};

export async function enforceConcurrentRegisterLimit(
  tx: ScopedDb,
  input: Pick<OpenDrawerSessionInput, 'organizationId' | 'entitlementLimits'>
): Promise<void> {
  const limit = resolveEntitlementLimit(input.entitlementLimits, POS_CONCURRENT_REGISTERS_LIMIT);
  if (limit.status !== 'configured') {
    throw new DrawerSessionError(
      'The concurrent register limit is not configured correctly.',
      'LIMIT_UNAVAILABLE'
    );
  }
  if (limit.value === 0) {
    throw new DrawerSessionError('Register sessions are disabled.', 'LIMIT_REACHED');
  }
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-concurrent-registers:${input.organizationId}`}, 0))`
  );
  const openRegisters = await tx.restaurantDrawerSession.count({
    where: { organizationId: input.organizationId, status: 'OPEN' },
  });
  if (openRegisters >= limit.value) {
    throw new DrawerSessionError(
      `Concurrent register limit reached (${openRegisters}/${limit.value}).`,
      'LIMIT_REACHED'
    );
  }
}

/** Return only the authenticated register's open drawer. The branch predicate is
 * deliberately part of the same query so a foreign drawer is never disclosed. */
export async function getCurrentDrawerSession(
  db: ScopedDb,
  input: { branchId: string; deviceId: string }
): Promise<CurrentDrawerSessionResult | null> {
  const session = await db.restaurantDrawerSession.findFirst({
    where: { branchId: input.branchId, deviceId: input.deviceId, status: 'OPEN' },
    select: { id: true, businessDate: true, openingFloat: true },
  });
  return session
    ? {
        drawerSessionId: session.id,
        businessDate: session.businessDate,
        openingFloat: session.openingFloat,
      }
    : null;
}

/**
 * Open a drawer for `actor.deviceId` (the register) operated by
 * `actor.staffProfileId`, on the branch's current business date. Rejects a second
 * OPEN session on the same register (pre-check + the partial-unique backstop for a
 * concurrent race), records the opening float as an OPENING_FLOAT movement, and is
 * idempotent (`cash:open`).
 */
export async function openDrawerSession(
  db: ScopedDb,
  input: OpenDrawerSessionInput
): Promise<OpenDrawerSessionResult> {
  const at = input.now ?? new Date();
  return runMoneyTransaction(db, async (tx) => {
    const idem = await beginMoneyIdempotent(tx, input.actor, 'cash.open');
    if (idem.replay) {
      const session = await requireSessionSummary(tx, idem.resultRef);
      return {
        drawerSessionId: session.id,
        businessDate: session.businessDate,
        openingFloat: session.openingFloat,
        replayed: true,
      };
    }

    const branch = await tx.restaurantBranch.findUnique({
      where: { id: input.branchId },
      select: { id: true, timezone: true, businessDayCutoff: true },
    });
    if (!branch) {
      throw new DrawerSessionError('The branch does not exist.', 'BRANCH_NOT_FOUND');
    }
    const device = await tx.restaurantRegisteredDevice.findUnique({
      where: { id: input.actor.deviceId },
      select: { id: true, branchId: true },
    });
    if (!device) {
      throw new DrawerSessionError('The register device does not exist.', 'DEVICE_NOT_FOUND');
    }
    if (device.branchId !== branch.id) {
      throw new DrawerSessionError(
        'The register device does not belong to this branch.',
        'DEVICE_BRANCH_MISMATCH'
      );
    }

    await enforceConcurrentRegisterLimit(tx, input);

    const existingOpen = await tx.restaurantDrawerSession.findFirst({
      where: { deviceId: device.id, status: 'OPEN' },
      select: { id: true },
    });
    if (existingOpen) {
      throw new DrawerSessionError(
        'This register already has an open drawer; close it before opening another.',
        'DRAWER_ALREADY_OPEN'
      );
    }

    const openingFloat = requireNonNegative(money(input.openingFloat), 'The opening float');
    const businessDate = businessDateToUtcDate(
      resolveBusinessDate(at, branch.timezone, branch.businessDayCutoff)
    );

    let sessionId: string;
    try {
      const session = await tx.restaurantDrawerSession.create({
        data: {
          branchId: branch.id,
          deviceId: device.id,
          staffProfileId: input.actor.staffProfileId,
          businessDate,
          status: 'OPEN',
          openedAt: at,
          openingFloat,
        },
        select: { id: true },
      });
      sessionId = session.id;
    } catch (err) {
      // The partial unique (one OPEN per register) is the concurrency backstop:
      // a duplicate that raced past the pre-check surfaces here as P2002.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DrawerSessionError(
          'This register already has an open drawer; close it before opening another.',
          'DRAWER_ALREADY_OPEN'
        );
      }
      throw err;
    }

    await appendMovement(tx, {
      drawerSessionId: sessionId,
      kind: 'OPENING_FLOAT',
      amount: openingFloat,
      staffProfileId: input.actor.staffProfileId,
      deviceId: input.actor.deviceId,
    });
    await recordMoneyResult(tx, input.actor, sessionId);

    return { drawerSessionId: sessionId, businessDate, openingFloat, replayed: false };
  });
}

async function requireSessionSummary(tx: ScopedDb, sessionId: string | null) {
  if (!sessionId) {
    throw new DrawerSessionError('The idempotent result reference is missing.', 'INVALID');
  }
  const session = await tx.restaurantDrawerSession.findUnique({
    where: { id: sessionId },
    select: { id: true, businessDate: true, openingFloat: true },
  });
  if (!session) {
    throw new DrawerSessionError('The drawer session does not exist.', 'DRAWER_NOT_FOUND');
  }
  return session;
}

// ── Paid-in / paid-out / drop (cash:adjust) ───────────────────────────────────

export type DrawerAdjustmentInput = {
  drawerSessionId: string;
  kind: DrawerAdjustmentKind;
  amount: Prisma.Decimal | string;
  reason: string;
  actor: MoneyActor;
};

export type DrawerAdjustmentResult = { movementId: string; replayed: boolean };

/**
 * Record a manual cash adjustment on an open drawer — a paid-in, paid-out, or drop
 * (`cash:adjust`). A reason is required (C8); the movement is appended to the
 * append-only ledger and the command is idempotent.
 */
export async function recordDrawerAdjustment(
  db: ScopedDb,
  input: DrawerAdjustmentInput
): Promise<DrawerAdjustmentResult> {
  return runMoneyTransaction(db, async (tx) => {
    const idem = await beginMoneyIdempotent(tx, input.actor, `cash.${input.kind.toLowerCase()}`);
    if (idem.replay) return { movementId: idem.resultRef ?? '', replayed: true };

    const reason = requireReason(input.reason);
    await requireActorDrawer(tx, input.drawerSessionId, input.actor.deviceId);
    const { movementId } = await appendMovement(tx, {
      drawerSessionId: input.drawerSessionId,
      kind: input.kind,
      amount: input.amount,
      reason,
      staffProfileId: input.actor.staffProfileId,
      deviceId: input.actor.deviceId,
    });
    await recordMoneyResult(tx, input.actor, movementId);
    return { movementId, replayed: false };
  });
}

// ── Close (cash:close) ────────────────────────────────────────────────────────

export type CloseDrawerSessionInput = {
  drawerSessionId: string;
  countedCash: Prisma.Decimal | string;
  actor: MoneyActor;
  now?: Date;
};

export type CloseDrawerSessionResult = {
  drawerSessionId: string;
  expectedCash: Prisma.Decimal;
  countedCash: Prisma.Decimal;
  variance: Prisma.Decimal;
  replayed: boolean;
};

/**
 * Close an open drawer: fold the ledger to derive expected cash, record the
 * counted cash + variance (counted − expected) ONCE, append a CLOSING_COUNT
 * movement, and flip OPEN→CLOSED (`cash:close`). Idempotent; a second close on an
 * already-closed session is rejected (the counts are write-once).
 */
export async function closeDrawerSession(
  db: ScopedDb,
  input: CloseDrawerSessionInput
): Promise<CloseDrawerSessionResult> {
  const at = input.now ?? new Date();
  return runMoneyTransaction(db, async (tx) => {
    const idem = await beginMoneyIdempotent(tx, input.actor, 'cash.close');
    if (idem.replay) {
      const closed = await requireClosedSummary(tx, idem.resultRef);
      return {
        drawerSessionId: closed.id,
        expectedCash: closed.expectedCash ?? ZERO,
        countedCash: closed.countedCash ?? ZERO,
        variance: closed.variance ?? ZERO,
        replayed: true,
      };
    }

    // Read the ledger only after all earlier movement writers have committed.
    await tx.$queryRaw`SELECT id FROM restaurant_drawer_sessions WHERE id = ${input.drawerSessionId} FOR UPDATE`;
    const session = await tx.restaurantDrawerSession.findFirst({
      where: { id: input.drawerSessionId, deviceId: input.actor.deviceId },
      select: {
        id: true,
        status: true,
        branchId: true,
        device: { select: { branchId: true } },
        movements: { select: { kind: true, amount: true } },
      },
    });
    if (!session || session.branchId !== session.device.branchId) {
      throw new DrawerSessionError('The drawer session does not exist.', 'DRAWER_NOT_FOUND');
    }
    if (session.status !== 'OPEN') {
      throw new DrawerSessionError('The drawer session is already closed.', 'ALREADY_CLOSED');
    }

    const countedCash = requireNonNegative(money(input.countedCash), 'The counted cash');
    const expectedCash = foldExpectedCash(session.movements as FoldableMovement[]);
    const variance = sub(countedCash, expectedCash);

    // The closing count joins the append-only ledger while the drawer is still
    // OPEN (CLOSING_COUNT folds to zero in `expectedCash`), then the session flips.
    await appendMovement(tx, {
      drawerSessionId: session.id,
      kind: 'CLOSING_COUNT',
      amount: countedCash,
      staffProfileId: input.actor.staffProfileId,
      deviceId: input.actor.deviceId,
    });
    await tx.restaurantDrawerSession.update({
      where: { id: session.id },
      data: {
        status: 'CLOSED',
        closedAt: at,
        expectedCash,
        countedCash,
        variance,
      },
    });
    await recordMoneyResult(tx, input.actor, session.id);

    return { drawerSessionId: session.id, expectedCash, countedCash, variance, replayed: false };
  });
}

/** Uniform ownership/branch guard used before adjustment writes. */
async function requireActorDrawer(tx: ScopedDb, drawerSessionId: string, deviceId: string) {
  const session = await tx.restaurantDrawerSession.findFirst({
    where: { id: drawerSessionId, deviceId },
    select: { id: true, branchId: true, device: { select: { branchId: true } } },
  });
  if (!session || session.branchId !== session.device.branchId) {
    throw new DrawerSessionError('The drawer session does not exist.', 'DRAWER_NOT_FOUND');
  }
  return session;
}

async function requireClosedSummary(tx: ScopedDb, sessionId: string | null) {
  if (!sessionId) {
    throw new DrawerSessionError('The idempotent result reference is missing.', 'INVALID');
  }
  const session = await tx.restaurantDrawerSession.findUnique({
    where: { id: sessionId },
    select: { id: true, expectedCash: true, countedCash: true, variance: true },
  });
  if (!session) {
    throw new DrawerSessionError('The drawer session does not exist.', 'DRAWER_NOT_FOUND');
  }
  return session;
}
