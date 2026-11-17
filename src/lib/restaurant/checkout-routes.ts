import { capabilityMatches } from '@/lib/abac/capabilities';
import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { readJson } from '@/lib/api-json';
import { liveDemoAccessExpiry } from '@/lib/auth/session-state';
import { demoApproverEmail, deriveDemoApproverPin } from '@/lib/demo/approval';
import { demoSeatFromOrganizationId } from '@/lib/demo/config';
import { demoPersonaForUser } from '@/lib/demo/personas';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { BillCommandError, evaluateOrderSettlement, type MoneyCommandActor } from './bills';
import { CoAuthorizationError } from './co-authorization';
import { resolveStaffCapabilityDecision } from './job-roles';
import {
  DailyCloseError,
  type ClosePreview,
  type CloseTotals,
  type CorrectCloseResult,
  type CutCloseResult,
  type TenderTypeTotal,
} from './daily-close';
import {
  DrawerSessionError,
  MoneyIdempotencyError,
  type CloseDrawerSessionResult,
  type OpenDrawerSessionResult,
} from './drawer-sessions';
import { PaymentAdapterError } from './payment-adapter';
import { RefundError, type RefundTenderResult } from './refunds';
import { quoteOpenBillSettlement, TenderError, type ApplyTenderResult } from './tenders';
import { TaxConfigurationError, TaxProfileResolutionError } from './tax-calculator';
import { OrderCommandError } from './orders';
import {
  authenticateApprover,
  buildActor,
  idempotencyKeyFromRequest,
  invalidBody,
  missingIdempotencyKey,
  requireActingOperator,
} from './terminal-orders';
import { withTerminalAuth, type TerminalContext } from './terminal-auth';

/**
 * M5-L5 — the register (POS-terminal) transport glue over the L2/L3/L4 money command
 * layer: bills & splits (`bills.ts`), tenders & refunds (`tenders.ts`/`refunds.ts`)
 * and drawer sessions + the daily close (`drawer-sessions.ts`/`daily-close.ts`).
 *
 * Routes stay THIN (the M2/M4 terminal pattern): authenticate the device + session
 * (`withTerminalAuth`, unchanged — C12), require an acting operator (C6), GATE the
 * operator on the route's money capability (C11), require an idempotency key on every
 * mutation (C11), parse a STRICT body (C11 — unknown fields rejected, never stripped),
 * build the attribution + idempotency envelope from trusted transport values (operator
 * = the session's active staff, device = the authenticated device, key = the
 * `Idempotency-Key` header — never the untrusted body), dispatch to the single command
 * layer, and shape any domain error into a clean HTTP status WITHOUT leaking internals.
 * No money domain logic lives here — the command layer owns the ledger append, the
 * settlement/receipt seam and the device-scoped `restaurant_money_idempotency_keys`
 * replay record (C11); this file only wires transport.
 *
 * Capability gate (C11). Terminal money routes gate on the EXISTING pos/payments/cash
 * capabilities, resolved from the acting operator's staff profile by UNIONING two
 * sources (QA-145): the linked `User`'s effective capabilities — the org-role permissions
 * + non-expired per-user overrides, evaluated exactly like the ABAC `customDecision` path
 * that the back-office `money:read` reads use — AND the restaurant SOP-1 job-role
 * capabilities the profile holds at the terminal's bound branch (see
 * `resolveStaffCapabilities` in `job-roles.ts`). Resolution is default-DENY: a profile
 * that NEITHER source grants — including a PIN-only operator with no linked user whose job
 * roles do not carry the capability — is refused (403). A co-authorized action
 * additionally verifies the approving manager's own credential AND that the approver
 * carries `coauth:approve` through either source; a PIN-only floor manager holding the
 * Owner job role can therefore approve. The platform org-role model is retained alongside
 * the job-role path (no restaurant operator capability column is added — no schema change,
 * C12); this coupling is recorded in BUILD-ASSUMPTIONS for the console + reconciliation lanes.
 *
 * Read contract (C12, consumed by L7a): the register's settled-bill receipt payload
 * (`buildReceiptForBranch`, display data only) and per-order settlement state
 * (`getOrderSettlementForBranch`) are shipped here; the day-close preview reuses L3's
 * `closePreview`. A console lane missing a read routes the defect back through the CoS
 * to this lane — UI lanes never write server queries.
 */

// ── Strict input schemas (C11) ───────────────────────────────────────────────

const ID = z.string().min(1);

/** A non-negative money amount as an exact decimal string (C2 — never a float, at most
 * the money scale of 2 fraction digits). The command layer performs domain validation
 * (over-tender, insufficient cash, refund caps); the schema only guarantees `money()`
 * receives a parseable Decimal so a malformed amount is a clean 400, not a 500. */
const MONEY = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Expected a non-negative money amount with up to 2 decimal places.');

const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" business date.');

/** A manager co-authorization presented inline for a comp / re-cut / refund / close
 * correction (C6). The manager proves their OWN credential at the terminal and must
 * carry `coauth:approve`; the command layer records the co-authorization evidence. */
const APPROVING = z
  .object({
    staffProfileId: ID,
    type: z.enum(['PIN', 'BADGE']),
    secret: z.string().min(1),
  })
  .strict();

const REFUND_APPROVING = z.discriminatedUnion('type', [
  APPROVING,
  z.object({ staffProfileId: ID, type: z.literal('DEMO') }).strict(),
]);

/** How to split an order into bills (mirrors `bills.ts` `SplitSpec`). */
const SPLIT = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NONE') }).strict(),
  z.object({ kind: z.literal('BY_ITEM'), groups: z.array(z.array(ID).min(1)).min(1) }).strict(),
  z.object({ kind: z.literal('BY_SEAT') }).strict(),
  z
    .object({ kind: z.literal('FRACTIONAL'), weights: z.array(z.number().positive()).min(1) })
    .strict(),
]);

export const billBody = z
  .object({
    orderId: ID,
    split: SPLIT,
    /** Present only when re-cutting an order that already has live bills: the reason and
     * the co-authorizing manager for the void-and-recut (C4). */
    recut: z
      .object({ reason: z.string().min(1), approving: APPROVING })
      .strict()
      .optional(),
  })
  .strict();

export const compBody = z
  .object({
    billId: ID,
    billLineId: ID,
    reason: z.string().min(1),
    approving: APPROVING,
  })
  .strict();

const CASH_TENDER = z
  .object({ type: z.literal('CASH'), amount: MONEY, cashReceived: MONEY })
  .strict();
/** The cashier confirms the card machine approved the payment: the approval code from
 * the slip plus the last 4 digits or terminal reference. A 13+ digit value (a possible
 * full card number) is refused. */
const MANUAL_CARD_CONFIRMATION = z
  .object({
    approvalCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{2,12}$/),
    reference: z
      .string()
      .trim()
      .regex(/^(?!\d{13,}$)[A-Za-z0-9]{4,24}$/),
  })
  .strict();
const CARD_TENDER = z
  .object({
    type: z.literal('CARD'),
    amount: MONEY,
    tipAmount: MONEY.optional(),
    manualConfirmation: MANUAL_CARD_CONFIRMATION.optional(),
  })
  .strict();
const OTHER_TENDER = z
  .object({ type: z.literal('OTHER'), amount: MONEY, tipAmount: MONEY.optional() })
  .strict();

export const tenderBody = z
  .object({
    billId: ID,
    tender: z.discriminatedUnion('type', [CASH_TENDER, CARD_TENDER, OTHER_TENDER]),
  })
  .strict();

export const refundBody = z
  .object({
    originalTenderId: ID,
    cardMachineRefundReference: z.string().trim().max(120).optional(),
    amount: MONEY,
    tipRefundAmount: MONEY.optional(),
    kind: z.enum(['REFUND', 'VOID_REVERSAL']).optional(),
    reason: z.string().trim().min(1).max(240),
    approving: REFUND_APPROVING,
  })
  .strict();

export const drawerOpenBody = z.object({ openingFloat: MONEY }).strict();

export const drawerMovementBody = z
  .object({
    drawerSessionId: ID,
    kind: z.enum(['PAID_IN', 'PAID_OUT', 'DROP']),
    amount: MONEY,
    reason: z.string().min(1),
  })
  .strict();

export const drawerCloseBody = z.object({ drawerSessionId: ID, countedCash: MONEY }).strict();

export const dayCloseBody = z.object({ businessDate: BUSINESS_DATE }).strict();

export const dayCorrectBody = z
  .object({
    businessDate: BUSINESS_DATE,
    supersedesCloseId: ID,
    reason: z.string().min(1),
    approving: APPROVING,
  })
  .strict();

// ── Capability gate (C11) ────────────────────────────────────────────────────

/** The six checkout and money capabilities a terminal route may gate on, plus the approver's
 * `coauth:approve` — all pre-existing entries in `vertical-catalog.ts` (C11). */
export type MoneyCapability =
  | 'orders:complimentary'
  | 'payments:collect'
  | 'payments:refund'
  | 'cash:open'
  | 'cash:adjust'
  | 'cash:close';

type CapabilityRule = { capability: string; effect: 'ALLOW' | 'DENY' };

/** Resolve branch-bound active staff access. Any matching DENY across linked-user
 * rules and staff overrides wins over all grants, including wildcard grants.
 * A branch binding is a primary branch, held job role, or direct staff override. */
export async function operatorHasCapability(
  db: ScopedDb,
  staffProfileId: string,
  capability: string,
  now: Date,
  branchId: string
): Promise<boolean> {
  if (!branchId?.trim()) return false;
  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: {
      status: true,
      primaryBranchId: true,
      jobRoles: { where: { branchId }, select: { branchId: true } },
      directCapabilityGrants: { where: { branchId }, select: { branchId: true } },
      user: {
        select: {
          organizationRole: {
            select: { permissions: { select: { capability: true, effect: true } } },
          },
          permissionOverrides: {
            where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            select: { capability: true, effect: true },
          },
        },
      },
    },
  });
  if (
    !profile ||
    profile.status !== 'ACTIVE' ||
    (profile.primaryBranchId !== branchId &&
      !profile.jobRoles.some((row) => row.branchId === branchId) &&
      !profile.directCapabilityGrants.some((row) => row.branchId === branchId))
  )
    return false;
  const user = profile.user;

  const decide = (rules: readonly CapabilityRule[]): boolean | null => {
    const matching = rules.filter((rule) =>
      capabilityMatches(rule.capability, capability, rule.effect === 'DENY' ? 'DENY' : 'ALLOW')
    );
    if (matching.some((rule) => rule.effect === 'DENY')) return false;
    if (matching.some((rule) => rule.effect === 'ALLOW')) return true;
    return null;
  };

  const staff = await resolveStaffCapabilityDecision(db, staffProfileId, branchId);
  const overrides = decide(user?.permissionOverrides ?? []);
  const role = decide(user?.organizationRole?.permissions ?? []);
  if (
    overrides === false ||
    role === false ||
    [...staff.denied].some((rule) => capabilityMatches(rule, capability, 'DENY'))
  )
    return false;

  return (
    overrides === true ||
    role === true ||
    [...staff.effective].some((rule) => capabilityMatches(rule, capability, 'ALLOW'))
  );
}

function forbidden(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}

export type DemoApproverIdentity = {
  staffProfileId: string;
  displayName: string;
  expiresAt: number;
};

export async function resolveDemoApproverIdentity(
  ctx: TerminalContext,
  now: Date
): Promise<DemoApproverIdentity | null> {
  const seat = demoSeatFromOrganizationId(ctx.organizationId);
  const actor = ctx.demoActor;
  const persona = seat && actor ? demoPersonaForUser(seat, actor.session.user) : null;
  const expiresAt = liveDemoAccessExpiry(actor?.session.user.demoAccessExpiresAt, now.getTime());
  if (
    !seat ||
    !actor ||
    actor.support ||
    !actor.organization.isDemo ||
    actor.organization.id !== ctx.organizationId ||
    actor.session.user.organizationId !== ctx.organizationId ||
    (persona !== 'manager' && persona !== 'owner') ||
    !expiresAt
  ) {
    return null;
  }
  const organization = await ctx.db.organization.findFirst({
    where: { id: ctx.organizationId, isDemo: true },
    select: { id: true },
  });
  if (!organization) return null;

  const profile = await ctx.db.restaurantStaffProfile.findFirst({
    where: {
      organizationId: ctx.organizationId,
      email: demoApproverEmail(seat),
      status: 'ACTIVE',
      primaryBranchId: ctx.device.branchId,
      user: { status: 'ACTIVE', organizationId: ctx.organizationId },
    },
    select: { id: true, displayName: true },
    orderBy: { id: 'asc' },
  });
  if (!profile || profile.id === ctx.session.activeStaffProfileId) return null;
  return { staffProfileId: profile.id, displayName: profile.displayName, expiresAt };
}

/** Gate the acting operator on `capability`; returns a 403 response when denied, or
 * null when the operator may proceed. */
async function requireCapability(
  db: ScopedDb,
  staffProfileId: string,
  capability: MoneyCapability,
  now: Date,
  branchId: string
): Promise<NextResponse | null> {
  const allowed = await operatorHasCapability(db, staffProfileId, capability, now, branchId);
  return allowed ? null : forbidden(`This operator lacks the "${capability}" capability.`);
}

/**
 * Authenticate an inline co-authorizing manager for a comp / re-cut / refund / close
 * correction: verify the manager's OWN credential (reusing the M4 approver check) and
 * that they carry `coauth:approve` (C11). Returns the approving staff id, or a ready
 * HTTP response (401/403/423) to short-circuit the route.
 */
async function resolveApprover(
  ctx: TerminalContext,
  approving: z.infer<typeof REFUND_APPROVING>,
  now: Date
): Promise<{ ok: true; staffProfileId: string } | { ok: false; response: NextResponse }> {
  let credential: z.infer<typeof APPROVING>;
  if (approving.type === 'DEMO') {
    const profile = await resolveDemoApproverIdentity(ctx, now);
    if (!profile || profile.staffProfileId !== approving.staffProfileId) {
      return {
        ok: false,
        response: forbidden('A distinct active demo approver is required.'),
      };
    }
    credential = {
      staffProfileId: profile.staffProfileId,
      type: 'PIN',
      secret: deriveDemoApproverPin(ctx.organizationId),
    };
  } else {
    credential = approving;
  }

  const auth = await authenticateApprover(
    ctx.db,
    ctx.device.id,
    ctx.device.branchId,
    credential,
    now
  );
  if (!auth.ok) return auth;
  const canApprove = await operatorHasCapability(
    ctx.db,
    auth.staffProfileId,
    'coauth:approve',
    now,
    ctx.device.branchId
  );
  if (!canApprove) {
    return {
      ok: false,
      response: forbidden('The approving manager lacks the "coauth:approve" capability.'),
    };
  }
  return { ok: true, staffProfileId: auth.staffProfileId };
}

// ── Domain-error → HTTP shaping (no internals leaked) ─────────────────────────

const json = (body: unknown, status: number): NextResponse => NextResponse.json(body, { status });

/**
 * Map a money-domain error onto the right HTTP status without leaking internals: a
 * not-found onto 404, a state/precondition conflict onto 409, a declined card onto 402,
 * everything else onto a 400 with the authored domain message. Returns null for a
 * non-domain error so the route can rethrow it and let the transport wrapper answer a
 * generic 500.
 */
export function moneyErrorResponse(err: unknown): NextResponse | null {
  // Map only after the terminal transaction rolls back. Configuration errors
  // may contain internal profile/rule IDs, so return fixed operator guidance.
  if (err instanceof TaxProfileResolutionError) {
    const error =
      err.reason === 'AMBIGUOUS'
        ? 'Conflicting effective tax profiles. Ask an administrator to correct the branch tax configuration before tendering.'
        : 'The branch has no current effective tax profile. Ask an administrator to publish a tax profile before tendering.';
    return json({ error, code: err.code }, 409);
  }
  if (err instanceof TaxConfigurationError) {
    return json(
      {
        error:
          'The branch tax configuration is invalid. Ask an administrator to correct it before tendering.',
      },
      409
    );
  }
  if (err instanceof MoneyIdempotencyError) {
    return json({ error: err.message }, 409);
  }
  if (err instanceof OrderCommandError) {
    return json(
      { error: err.message },
      err.reason === 'ORDER_NOT_FOUND' ? 404 : err.reason === 'DAY_CLOSED' ? 409 : 400
    );
  }
  if (err instanceof BillCommandError) {
    const notFound =
      err.reason === 'ORDER_NOT_FOUND' ||
      err.reason === 'BILL_NOT_FOUND' ||
      err.reason === 'LINE_NOT_FOUND';
    const conflict =
      err.reason === 'ORDER_NOT_BILLABLE' ||
      err.reason === 'BILL_NOT_OPEN' ||
      err.reason === 'RESPLIT_LOCKED' ||
      err.reason === 'ALREADY_COMPED' ||
      err.reason === 'NOT_COMPED' ||
      err.reason === 'IDEMPOTENCY_CONFLICT';
    return json({ error: err.message }, notFound ? 404 : conflict ? 409 : 400);
  }
  if (err instanceof TenderError) {
    if (err.reason === 'CARD_DECLINED') return json({ error: err.message }, 402);
    const notFound = err.reason === 'BILL_NOT_FOUND';
    const conflict =
      err.reason === 'BILL_NOT_OPEN' ||
      err.reason === 'OVER_TENDER' ||
      err.reason === 'DRAWER_NOT_OPEN';
    return json({ error: err.message }, notFound ? 404 : conflict ? 409 : 400);
  }
  if (err instanceof RefundError) {
    const notFound = err.reason === 'TENDER_NOT_FOUND' || err.reason === 'PAYMENT_NOT_FOUND';
    const conflict =
      err.reason === 'BILL_NOT_SETTLED' ||
      err.reason === 'REFUND_EXCEEDS_TENDER' ||
      err.reason === 'TIP_REFUND_EXCEEDS_TENDER' ||
      err.reason === 'INVALID_REVERSAL' ||
      err.reason === 'DRAWER_NOT_OPEN';
    return json({ error: err.message }, notFound ? 404 : conflict ? 409 : 400);
  }
  if (err instanceof DrawerSessionError) {
    const notFound =
      err.reason === 'BRANCH_NOT_FOUND' ||
      err.reason === 'DEVICE_NOT_FOUND' ||
      err.reason === 'DRAWER_NOT_FOUND';
    const conflict =
      err.reason === 'DRAWER_NOT_OPEN' ||
      err.reason === 'DRAWER_ALREADY_OPEN' ||
      err.reason === 'ALREADY_CLOSED' ||
      err.reason === 'DEVICE_BRANCH_MISMATCH' ||
      err.reason === 'LIMIT_REACHED' ||
      err.reason === 'LIMIT_UNAVAILABLE';
    return json({ error: err.message }, notFound ? 404 : conflict ? 409 : 400);
  }
  if (err instanceof DailyCloseError) {
    const notFound = err.reason === 'CLOSE_NOT_FOUND';
    const conflict =
      err.reason === 'UNSETTLED_BILL' ||
      err.reason === 'ACTIVE_ORDERS' ||
      err.reason === 'OPEN_DRAWER' ||
      err.reason === 'CLOSE_EXISTS' ||
      err.reason === 'NOTHING_TO_CORRECT' ||
      err.reason === 'NOT_TIP';
    return json({ error: err.message }, notFound ? 404 : conflict ? 409 : 400);
  }
  if (err instanceof PaymentAdapterError) {
    return json({ error: err.message }, 400);
  }
  if (err instanceof CoAuthorizationError) {
    return json({ error: err.message }, 400);
  }
  return null;
}

// ── Route factories ──────────────────────────────────────────────────────────

/** Build the money command attribution + idempotency envelope from trusted transport
 * values only (never the request body). Structurally the `MoneyCommandActor`/`MoneyActor`
 * the command layer expects. */
function buildMoneyActor(staffProfileId: string, deviceId: string, key: string): MoneyCommandActor {
  return buildActor(staffProfileId, deviceId, key);
}

/** The arguments a money command handler receives from `moneyMutationRoute`. */
export type MoneyCommandArgs<S extends z.ZodTypeAny> = {
  ctx: TerminalContext;
  data: z.infer<S>;
  actor: MoneyCommandActor;
  now: Date;
};

/** Reject a bill outside the authenticated terminal branch before approval work. */
export async function requireBillInDeviceBranch(
  db: ScopedDb,
  billId: string,
  branchId: string
): Promise<boolean> {
  const bill = await db.restaurantBill.findFirst({
    where: { id: billId, branchId },
    select: { id: true },
  });
  return bill !== null;
}

/**
 * The shared shape of a money MUTATION route: `withTerminalAuth` (device + live
 * session, revoked-device rejected — C12), require an acting operator (C6), gate on the
 * route capability (C11), require an idempotency key (C11), parse the STRICT body,
 * build the attribution envelope, and dispatch. `run` returns the command result to
 * serialise, OR a `Response` to short-circuit (e.g. a failed co-authorization).
 *
 * A THROW IS NOT CAUGHT HERE (M8 correction E). `withTerminalAuth` owns the request's
 * PostgreSQL transaction and a nested `$transaction` on the scoped client opens no
 * savepoint, so an error mapped to a `Response` inside this callback would commit
 * whatever the failed command had already written — a comp that released a loyalty
 * redemption before refusing, a void-and-recut that released and voided before failing
 * split planning, and in both cases the money idempotency key the retry then replayed
 * against nothing. `moneyErrorResponse` is handed to the transport as its `mapError`
 * instead: the error escapes the transaction (PostgreSQL rolls the request back) and is
 * shaped afterwards, onto exactly the same status and body as before. A non-domain error
 * still becomes a generic 500 (no internals leaked).
 */
export function moneyMutationRoute<S extends z.ZodTypeAny>(opts: {
  schema: S;
  capability: MoneyCapability;
  run: (args: MoneyCommandArgs<S>) => Promise<unknown>;
  successStatus?: number;
  /** Resolve bill ids within the authenticated register branch only after the
   * capability decision, so an unauthorized operator cannot probe bill existence. */
  obscureBillId?: (data: z.infer<S>) => string;
  /** Restrict a money route to a physical register before any resource lookup. */
  deviceKind?: 'POS' | 'KDS';
}) {
  return withTerminalAuth(
    async (ctx, request) => {
      const operator = requireActingOperator(ctx);
      if (!operator.ok) return operator.response;
      if (opts.deviceKind && ctx.device.kind !== opts.deviceKind) {
        return forbidden(`A ${opts.deviceKind} register is required.`);
      }

      const now = new Date();
      const denied = await requireCapability(
        ctx.db,
        operator.staffProfileId,
        opts.capability,
        now,
        ctx.device.branchId
      );
      if (denied) return denied;

      const key = idempotencyKeyFromRequest(request);
      if (!key) return missingIdempotencyKey();
      const parsedJson = await readJson(request);
      if (!parsedJson.ok) return parsedJson.response;
      const parsed = opts.schema.safeParse(parsedJson.data);
      if (!parsed.success) return invalidBody(parsed.error.issues);
      if (opts.obscureBillId) {
        const visible = await requireBillInDeviceBranch(
          ctx.db,
          opts.obscureBillId(parsed.data),
          ctx.device.branchId
        );
        if (!visible) return json({ error: 'No settled bill with that id.' }, 404);
      }

      const actor = buildMoneyActor(operator.staffProfileId, ctx.device.id, key);
      const out = await opts.run({ ctx, data: parsed.data, actor, now });
      if (out instanceof Response) return out;
      return NextResponse.json(out as Record<string, unknown>, {
        status: opts.successStatus ?? 200,
      });
    },
    { mapError: moneyErrorResponse }
  );
}

/**
 * The shared shape of a money READ route (register display data): `withTerminalAuth`,
 * require an acting operator, gate on the route capability (C11 — financial reads are
 * capability-gated too), then run the read. No idempotency key (nothing is written).
 * Errors are mapped by the transport, outside the owning transaction, on the same rule as
 * the mutation factory: a read cannot corrupt money today, but the boundary keeps ONE
 * ordering so a read that later writes (an audit or access-log row) cannot reintroduce
 * the commit-a-failed-command defect. The statuses and bodies are unchanged.
 */
export function moneyReadRoute(opts: {
  capability: MoneyCapability;
  run: (ctx: TerminalContext, request: Request) => Promise<Response>;
  deviceKind?: 'POS' | 'KDS';
}) {
  return withTerminalAuth(
    async (ctx, request) => {
      const operator = requireActingOperator(ctx);
      if (!operator.ok) return operator.response;
      if (opts.deviceKind && ctx.device.kind !== opts.deviceKind) {
        return forbidden(`A ${opts.deviceKind} register is required.`);
      }

      const now = new Date();
      const denied = await requireCapability(
        ctx.db,
        operator.staffProfileId,
        opts.capability,
        now,
        ctx.device.branchId
      );
      if (denied) return denied;

      return await opts.run(ctx, request);
    },
    { mapError: moneyErrorResponse }
  );
}

// ── Register read model (C12 — read contract, consumed by L7a) ────────────────

const money = (value: Prisma.Decimal): string => value.toFixed(2);

/**
 * The per-order bill/settlement state for the register, scoped to the device's branch
 * (a cross-branch or cross-tenant order id is indistinguishable from "not found").
 * Mirrors the back-office `getOrderSettlement` serialisation (Decimals as strings, C2).
 * Returns null when the order is not in the device's branch (route → 404).
 */
export async function getOrderSettlementForBranch(
  db: ScopedDb,
  orderId: string,
  branchId: string,
  at: Date = new Date()
) {
  const order = await db.restaurantOrder.findFirst({
    where: { id: orderId, branchId },
    select: {
      id: true,
      deliveryFulfillment: { select: { deliveryFeeSnapshot: true } },
    },
  });
  if (!order) return null;

  const settlement = await evaluateOrderSettlement(db, orderId);
  const unbilledItemRows = settlement.unbilledItemIds.length
    ? await db.restaurantOrderItem.findMany({
        where: { id: { in: settlement.unbilledItemIds }, orderId },
        select: {
          id: true,
          name: true,
          quantity: true,
          seatNumber: true,
          modifiers: { select: { name: true }, orderBy: { createdAt: 'asc' } },
        },
      })
    : [];
  const unbilledItemsById = new Map(unbilledItemRows.map((item) => [item.id, item]));
  const billLines = settlement.bills.length
    ? await db.restaurantBillLine.findMany({
        where: { billId: { in: settlement.bills.map((bill) => bill.id) } },
        orderBy: [{ billId: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          billId: true,
          name: true,
          quantity: true,
          lineSubtotal: true,
          compAmount: true,
        },
      })
    : [];
  const linesByBill = new Map<string, typeof billLines>();
  for (const line of billLines) {
    const current = linesByBill.get(line.billId) ?? [];
    current.push(line);
    linesByBill.set(line.billId, current);
  }
  const bills = await Promise.all(
    settlement.bills.map(async (b) => {
      // An OPEN bill's stored grandTotal is pre-tax and its taxTotal is 0 until a
      // tender freezes it, so disclose the live tax quote the tender will charge —
      // otherwise the register hides tax and shows a due that cannot settle the bill
      // (QA-143). A SETTLED bill already carries its frozen tax/total.
      const quote = b.status === 'OPEN' ? await quoteOpenBillSettlement(db, b.id, at) : null;
      return {
        id: b.id,
        status: b.status,
        splitKind: b.splitKind,
        grandTotal: money(quote ? quote.grandTotal : b.grandTotal),
        taxTotal: money(quote ? quote.tax : b.taxTotal),
        remainingDue: money(quote ? quote.remainingDue : b.remainingDue),
        deliveryFeeTotal: money(b.deliveryFeeTotal),
        compTotal: money(b.compTotal),
        receiptNumber: b.receiptNumber,
        lines: (linesByBill.get(b.id) ?? []).map((line) => ({
          id: line.id,
          name: line.name,
          quantity: line.quantity,
          lineSubtotal: money(line.lineSubtotal),
          compAmount: money(line.compAmount),
        })),
      };
    })
  );
  return {
    orderId: settlement.orderId,
    settled: settlement.settled,
    blocker: settlement.blocker,
    derivedOrderTotal: money(settlement.derivedOrderTotal),
    accountedTotal: money(settlement.accountedTotal),
    deliveryFeeTotal: order.deliveryFulfillment
      ? money(order.deliveryFulfillment.deliveryFeeSnapshot)
      : null,
    unbilledItemIds: settlement.unbilledItemIds,
    unbilledItems: settlement.unbilledItemIds.flatMap((id) => {
      const item = unbilledItemsById.get(id);
      return item
        ? [
            {
              id: item.id,
              name: item.name,
              quantity: item.quantity,
              seatNumber: item.seatNumber,
              modifiers: item.modifiers.map((modifier) => modifier.name),
            },
          ]
        : [];
    }),
    bills,
  };
}

/**
 * The settled-bill receipt payload for the register — DISPLAY DATA ONLY (C6/C10). Scoped
 * to the device's branch and returned only for a SETTLED bill (a receipt number is
 * allocated exactly once, at settlement). Carries the receipt number seam, the bill's
 * lines and totals, and the tenders with their change/tip — never PAN/CVV/track data
 * (only the provider reference is stored on the payment, and it is not surfaced here).
 * Returns null when the bill is not a settled bill in the device's branch (route → 404).
 */
export async function buildReceiptForBranch(db: ScopedDb, billId: string, branchId: string) {
  const bill = await db.restaurantBill.findFirst({
    where: { id: billId, branchId, status: 'SETTLED' },
    select: {
      id: true,
      orderId: true,
      branchId: true,
      businessDate: true,
      status: true,
      splitKind: true,
      fractionNumerator: true,
      fractionDenominator: true,
      subtotal: true,
      taxTotal: true,
      serviceChargeTotal: true,
      deliveryFeeTotal: true,
      compTotal: true,
      discountTotal: true,
      roundingAdjustment: true,
      grandTotal: true,
      receiptNumber: true,
      settledAt: true,
      branch: { select: { name: true, timezone: true } },
      order: {
        select: {
          orderNumber: true,
          channel: true,
          customer: {
            select: {
              loyaltyAccount: {
                select: {
                  id: true,
                  active: true,
                  walletPasses: {
                    where: { status: 'ACTIVE' },
                    select: { platform: true },
                  },
                },
              },
            },
          },
        },
      },
      lines: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          quantity: true,
          unitPrice: true,
          lineSubtotal: true,
          compAmount: true,
          lineTotal: true,
        },
      },
      tenders: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          amount: true,
          tipAmount: true,
          changeGiven: true,
          createdAt: true,
        },
      },
    },
  });
  if (!bill) return null;

  const account = bill.order.customer?.loyaltyAccount;
  const loyaltyWallet =
    account?.active && account.walletPasses.length > 0
      ? {
          // A receipt is a settlement record, so later earns, redemptions, refunds,
          // and adjustments must not rewrite the balance shown on a historical copy.
          balance:
            (
              await db.loyaltyPointsEntry.aggregate({
                where: { accountId: account.id, occurredAt: { lte: bill.settledAt! } },
                _sum: { points: true },
              })
            )._sum.points ?? 0,
          platforms: [...new Set(account.walletPasses.map(({ platform }) => platform))],
        }
      : null;

  return {
    billId: bill.id,
    orderId: bill.orderId,
    orderNumber: bill.order.orderNumber,
    channel: bill.order.channel,
    branchId: bill.branchId,
    branchName: bill.branch.name,
    businessDate: bill.businessDate.toISOString().slice(0, 10),
    receiptNumber: bill.receiptNumber,
    settledAt: bill.settledAt,
    splitKind: bill.splitKind,
    loyaltyWallet,
    fractionNumerator: bill.fractionNumerator,
    fractionDenominator: bill.fractionDenominator,
    lines: bill.lines.map((line) => ({
      id: line.id,
      name: line.name,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      lineSubtotal: money(line.lineSubtotal),
      compAmount: money(line.compAmount),
      lineTotal: money(line.lineTotal),
    })),
    tenders: bill.tenders.map((t) => ({
      id: t.id,
      type: t.type,
      amount: money(t.amount),
      tipAmount: money(t.tipAmount),
      changeGiven: t.changeGiven === null ? null : money(t.changeGiven),
    })),
    totals: {
      subtotal: money(bill.subtotal),
      taxTotal: money(bill.taxTotal),
      serviceChargeTotal: money(bill.serviceChargeTotal),
      deliveryFeeTotal: money(bill.deliveryFeeTotal),
      compTotal: money(bill.compTotal),
      discountTotal: money(bill.discountTotal),
      roundingAdjustment: money(bill.roundingAdjustment),
      grandTotal: money(bill.grandTotal),
    },
  };
}

// ── Command-result serialisers (Decimals → strings, C2) ──────────────────────

/** A tender result for the register: the applied amount, tip, cash change, whether this
 * tender settled the bill (+ receipt number), and the remaining balance — all Decimals
 * as strings. */
export function serializeTenderResult(result: ApplyTenderResult) {
  return {
    tenderId: result.tenderId,
    billId: result.billId,
    type: result.type,
    amount: money(result.amount),
    tipAmount: money(result.tipAmount),
    changeGiven: result.changeGiven === null ? null : money(result.changeGiven),
    paymentId: result.paymentId,
    drawerSessionId: result.drawerSessionId,
    settled: result.settled,
    receiptNumber: result.receiptNumber,
    remainingDue: money(result.remainingDue),
    replayed: result.replayed,
  };
}

export function serializeRefundResult(result: RefundTenderResult) {
  return {
    refundId: result.refundId,
    originalTenderId: result.originalTenderId,
    billId: result.billId,
    kind: result.kind,
    amount: money(result.amount),
    tipRefundAmount: money(result.tipRefundAmount),
    serviceChargeRefundAmount: money(result.serviceChargeRefundAmount),
    deliveryFeeRefundAmount: money(result.deliveryFeeRefundAmount),
    taxRefundAmount: money(result.taxRefundAmount),
    businessDate: result.businessDate.toISOString().slice(0, 10),
    paymentId: result.paymentId,
    drawerSessionId: result.drawerSessionId,
    paymentStatus: result.paymentStatus,
    replayed: result.replayed,
  };
}

export function serializeDrawerOpenResult(result: OpenDrawerSessionResult) {
  return {
    drawerSessionId: result.drawerSessionId,
    businessDate: result.businessDate.toISOString().slice(0, 10),
    openingFloat: money(result.openingFloat),
    replayed: result.replayed,
  };
}

export function serializeDrawerCloseResult(result: CloseDrawerSessionResult) {
  return {
    drawerSessionId: result.drawerSessionId,
    expectedCash: money(result.expectedCash),
    countedCash: money(result.countedCash),
    variance: money(result.variance),
    replayed: result.replayed,
  };
}

function serializeCloseTotals(totals: CloseTotals) {
  return {
    grossSales: money(totals.grossSales),
    netSales: money(totals.netSales),
    deliveryFeeSales: money(totals.deliveryFeeSales),
    deliveryFeeRefunds: money(totals.deliveryFeeRefunds),
    taxTotal: money(totals.taxTotal),
    serviceChargeTotal: money(totals.serviceChargeTotal),
    tipTotal: money(totals.tipTotal),
    compTotal: money(totals.compTotal),
    discountTotal: money(totals.discountTotal),
    refundTotal: money(totals.refundTotal),
    voidTotal: money(totals.voidTotal),
    cashExpected: money(totals.cashExpected),
    cashCounted: money(totals.cashCounted),
    cashVariance: money(totals.cashVariance),
  };
}

function serializeTenderTotals(totals: readonly TenderTypeTotal[]) {
  return totals.map((t) => ({
    tenderType: t.tenderType,
    amount: money(t.amount),
    tipAmount: money(t.tipAmount),
    count: t.count,
  }));
}

/** The day-close preview for the register: the folded totals + per-tender-type totals,
 * the close readiness guards, and the current chain-tip close id (if any). */
export function serializeClosePreview(preview: ClosePreview) {
  return {
    branchId: preview.branchId,
    businessDate: preview.businessDate.toISOString().slice(0, 10),
    totals: serializeCloseTotals(preview),
    tenderTotals: serializeTenderTotals(preview.tenderTotals),
    manualCardSummary: preview.manualCardSummary,
    readiness: preview.readiness,
    existingCloseId: preview.existingCloseId,
  };
}

export function serializeCutCloseResult(result: CutCloseResult) {
  return {
    dailyCloseId: result.dailyCloseId,
    totals: serializeCloseTotals(result.totals),
    tenderTotals: serializeTenderTotals(result.tenderTotals),
    manualCardSummary: result.manualCardSummary ?? null,
    replayed: result.replayed,
  };
}

export function serializeCorrectCloseResult(result: CorrectCloseResult) {
  return { ...serializeCutCloseResult(result), supersedesCloseId: result.supersedesCloseId };
}

// Re-exported for the co-authorization routes that resolve an approving manager inline.
export { resolveApprover };
