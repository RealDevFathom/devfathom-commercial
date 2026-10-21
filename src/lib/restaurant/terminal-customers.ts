import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { CustomerIdentifierKind } from '@/generated/prisma/client';
import { readJson } from '@/lib/api-json';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { operatorHasCapability } from './checkout-routes';
import { attachCustomerToOrder, CustomerError } from './customers';
import { withTerminalAuth, type TerminalContext } from './terminal-auth';
import { idempotencyKeyFromRequest, invalidBody, requireActingOperator } from './terminal-orders';

/**
 * M9-L2 — the POS-terminal transport glue over the M8 customer contracts, plus the
 * shared route factories the sibling loyalty lane file reuses.
 *
 * Routes stay THIN (the M2/M4/M5 terminal pattern): authenticate the device + session
 * (`withTerminalAuth`, unchanged), require an acting operator, gate that operator on the
 * route's vertical capability, parse a STRICT body/query (unknown fields rejected, never
 * stripped), derive org + branch from the TRUSTED transport (RLS pins the organization;
 * `ctx.device.branchId` pins the branch — never the body), dispatch to the M8 command
 * layer, and shape any domain error into a clean HTTP status without leaking internals.
 * No customer domain logic lives here.
 *
 * CONNECTED-ONLY (the M9 exclusion on offline payments/PII). Every operation in this file
 * and its loyalty sibling requires a live server round-trip and is never queued, replayed
 * from a local store, or serviced from a cache. Nothing read here is persisted client-side:
 * the search read model returns MASKED identifiers only, so a POS pad never holds a raw
 * email or phone number, and no PIN or payment instrument is read or returned on any path.
 *
 * Capability gate. These routes gate on the customer read/manage or loyalty redemption
 * capability appropriate to the operation, resolved through the SAME `operatorHasCapability`
 * seam the M5 money routes use (org-role permissions + non-expired per-user overrides,
 * default-DENY). The resolution rule is not forked; only the capability strings differ.
 * `MoneyCapability` in `checkout-routes.ts` deliberately stays the five money capabilities —
 * widening that union would let a customer/loyalty capability be passed to a money route — so
 * this lane declares its own `ConnectedCapability` union over the same resolver.
 *
 * Error mapping runs OUTSIDE the request transaction (M8 correction E): `withTerminalAuth`
 * owns the PostgreSQL transaction and a nested `$transaction` opens no savepoint, so an error
 * shaped into a `Response` *inside* the handler would COMMIT whatever the failed command had
 * already written. Every factory below hands its mapper to the transport as `mapError`, so the
 * error escapes, PostgreSQL rolls the request back, and the status is shaped afterwards.
 */

// ── Strict input schemas ─────────────────────────────────────────────────────

const ID = z.string().min(1);

/** A POS search must be a deliberate lookup, never a customer-book dump: the pad has to
 * supply at least two characters and can never page beyond one screen of matches. */
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

export const customerSearchQuery = z
  .object({
    query: z
      .string()
      .trim()
      .min(MIN_QUERY_LENGTH, 'Search for at least two characters of a name, email, or phone.'),
    limit: z.coerce.number().int().min(1).max(MAX_RESULTS).optional(),
  })
  .strict();

export const customerAttachBody = z.object({ orderId: ID, customerId: ID }).strict();

export const walletScanQuery = z
  .object({ code: z.string().regex(/^DFW1:wla_[0-9a-hjkmnp-tv-z]{26}$/) })
  .strict();

// ── Capability gate + route factories (shared with `terminal-loyalty.ts`) ─────

/** The vertical capabilities this lane's connected routes gate on. */
export type ConnectedCapability =
  'customers:read' | 'customers:manage' | 'loyalty:redeem' | 'orders:take';

const json = (body: unknown, status: number): NextResponse => NextResponse.json(body, { status });

function forbidden(capability: ConnectedCapability): NextResponse {
  return json({ error: `This operator lacks the "${capability}" capability.` }, 403);
}

/** Map a customer-domain error onto a status without leaking internals: a missing
 * customer/order onto 404, a state precondition (wrong order status, already another
 * guest's order, anonymized profile) onto 409, everything else onto 400. Returns null
 * for a non-domain error so the transport answers a generic 500. */
export function customerErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof CustomerError)) return null;
  if (err.reason === 'NOT_FOUND') return json({ error: err.message }, 404);
  const conflict =
    err.reason === 'INVALID_STATE' ||
    err.reason === 'ANONYMIZED' ||
    err.reason === 'DUPLICATE_IDENTIFIER' ||
    err.reason === 'DUPLICATE_TAG';
  return json({ error: err.message }, conflict ? 409 : 400);
}

/**
 * A connected READ route: device + session auth, an acting operator, and the route's
 * capability — then the read. No idempotency key (nothing is written).
 */
export function connectedReadRoute(opts: {
  capability: ConnectedCapability;
  moduleKey?: string;
  mapError?: (err: unknown) => NextResponse | null;
  run: (ctx: TerminalContext, request: Request) => Promise<Response>;
}) {
  return withTerminalAuth(
    async (ctx, request) => {
      const operator = requireActingOperator(ctx);
      if (!operator.ok) return operator.response;
      if (
        !(await operatorHasCapability(
          ctx.db,
          operator.staffProfileId,
          opts.capability,
          new Date(),
          ctx.device.branchId
        ))
      ) {
        return forbidden(opts.capability);
      }
      if (opts.moduleKey) {
        const entitlements = await resolveOrganizationEntitlements(ctx.organizationId, ctx.db);
        if (!hasModule(entitlements, opts.moduleKey)) {
          return json({ error: 'The loyalty module is not enabled for this organization.' }, 403);
        }
      }
      return await opts.run(ctx, request);
    },
    { mapError: opts.mapError }
  );
}

/**
 * What a connected mutation handler receives — all of it derived from trusted transport.
 *
 * `K` carries the `Idempotency-Key` guarantee in the TYPE. A route declared with
 * `requireIdempotencyKey: true` has already been answered a 400 by the factory when the header
 * was missing, so its handler receives a plain `string` and needs no non-null assertion to
 * thread the key into a command's replay record.
 */
export type ConnectedMutationArgs<S extends z.ZodTypeAny, K extends string | null> = {
  ctx: TerminalContext;
  data: z.infer<S>;
  staffProfileId: string;
  idempotencyKey: K;
  now: Date;
};

/**
 * A connected MUTATION route: device + session auth, an acting operator, the route's
 * capability, an optional `Idempotency-Key` requirement, and a STRICT body — then dispatch.
 *
 * `requireIdempotencyKey` is opt-in rather than always-on because it must be honest: a route
 * that demands the header has to actually thread it into the command layer's replay record.
 * Loyalty redemption does (`redeemLoyaltyPoints` keys its ledger entry on it); customer attach
 * does not need one, because it is naturally idempotent — the M8 command only matches an order
 * whose customer is null or already this same customer, so a retry re-reaches the same state
 * and a different guest is a 409 rather than a silent overwrite.
 */
export function connectedMutationRoute<S extends z.ZodTypeAny, R extends boolean = false>(opts: {
  schema: S;
  capability: ConnectedCapability;
  additionalCapabilities?: readonly ConnectedCapability[];
  requireIdempotencyKey?: R;
  mapError?: (err: unknown) => NextResponse | null;
  run: (
    args: ConnectedMutationArgs<S, R extends true ? string : string | null>
  ) => Promise<Response | unknown>;
  successStatus?: number;
}) {
  return withTerminalAuth(
    async (ctx, request) => {
      const operator = requireActingOperator(ctx);
      if (!operator.ok) return operator.response;

      const now = new Date();
      if (
        !(await operatorHasCapability(
          ctx.db,
          operator.staffProfileId,
          opts.capability,
          now,
          ctx.device.branchId
        ))
      ) {
        return forbidden(opts.capability);
      }
      for (const capability of opts.additionalCapabilities ?? []) {
        if (
          !(await operatorHasCapability(
            ctx.db,
            operator.staffProfileId,
            capability,
            now,
            ctx.device.branchId
          ))
        ) {
          return forbidden(capability);
        }
      }

      const idempotencyKey = idempotencyKeyFromRequest(request);
      if (opts.requireIdempotencyKey && !idempotencyKey) {
        return json({ error: 'Missing Idempotency-Key header.' }, 400);
      }

      const parsedJson = await readJson(request);
      if (!parsedJson.ok) return parsedJson.response;
      const parsed = opts.schema.safeParse(parsedJson.data);
      if (!parsed.success) return invalidBody(parsed.error.issues);

      const out = await opts.run({
        ctx,
        data: parsed.data,
        staffProfileId: operator.staffProfileId,
        // The `requireIdempotencyKey` guard above has already answered a 400 when the header was
        // missing, so for a route that asked for one the key really is a `string`. TypeScript
        // cannot carry that from a runtime flag across to the conditional parameter type, so the
        // narrowing is asserted ONCE here — beside the guard that makes it true — rather than as
        // a non-null assertion in every route that threads a key into a replay record.
        idempotencyKey: idempotencyKey as R extends true ? string : string | null,
        now,
      });
      if (out instanceof Response) return out;
      return NextResponse.json(out as Record<string, unknown>, {
        status: opts.successStatus ?? 200,
      });
    },
    { mapError: opts.mapError }
  );
}

// ── Device-scoped read model (masked — no raw PII leaves the server) ──────────

/**
 * Mask a stored identifier for display on a POS pad. The cashier needs just enough to
 * confirm "yes, that's the guest in front of me"; the pad never receives the raw value,
 * so a compromised or cached terminal payload discloses no contactable address.
 *
 * EMAIL keeps the first character and the domain (`j••••@example.com`); PHONE keeps only
 * the last four digits (`•••• 1234`). A value too short to mask degrades to all dots
 * rather than revealing itself.
 */
export function maskCustomerIdentifier(kind: CustomerIdentifierKind, value: string): string {
  if (kind === 'EMAIL') {
    const at = value.lastIndexOf('@');
    if (at <= 0) return '•••••';
    const local = value.slice(0, at);
    return `${local[0]}${'•'.repeat(Math.max(local.length - 1, 1))}${value.slice(at)}`;
  }
  return value.length > 4 ? `•••• ${value.slice(-4)}` : '••••';
}

export type TerminalCustomerMatch = {
  customerId: string;
  displayName: string | null;
  identifiers: { id: string; kind: CustomerIdentifierKind; masked: string }[];
};

/**
 * Search the organization's non-anonymized customers for the POS attach flow. RLS scopes
 * the read to the device's organization; the projection is deliberately narrow — id,
 * display name and MASKED identifiers only. Birth dates, notes, interaction history,
 * consents and tags are back-office reads and never cross to a terminal.
 */
export async function searchConnectedCustomers(
  db: ScopedDb,
  input: { query: string; limit?: number }
): Promise<TerminalCustomerMatch[]> {
  const query = input.query.trim();
  if (query.length < MIN_QUERY_LENGTH) return [];
  const rows = await db.restaurantCustomer.findMany({
    where: {
      anonymizedAt: null,
      OR: [
        { displayName: { contains: query, mode: 'insensitive' } },
        { givenName: { contains: query, mode: 'insensitive' } },
        { familyName: { contains: query, mode: 'insensitive' } },
        {
          identifiers: {
            some: {
              kind: { in: ['EMAIL', 'PHONE'] },
              normalizedValue: { contains: query.toLowerCase() },
            },
          },
        },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(input.limit ?? MAX_RESULTS, 1), MAX_RESULTS),
    select: {
      id: true,
      displayName: true,
      identifiers: {
        where: { kind: { in: ['EMAIL', 'PHONE'] } },
        orderBy: [{ kind: 'asc' }, { normalizedValue: 'asc' }, { id: 'asc' }],
        select: { id: true, kind: true, normalizedValue: true },
      },
    },
  });
  return rows.map((row) => ({
    customerId: row.id,
    displayName: row.displayName,
    identifiers: row.identifiers.map((identifier) => ({
      id: identifier.id,
      kind: identifier.kind,
      masked: maskCustomerIdentifier(identifier.kind, identifier.normalizedValue),
    })),
  }));
}

export type WalletScanResult = {
  customerId: string;
  loyalty: {
    accountId: string | null;
    accountActive: boolean;
    balance: number;
  };
};

/** Resolve only an active wallet alias inside the terminal's tenant transaction. */
export async function resolveWalletScan(
  db: ScopedDb,
  alias: string
): Promise<WalletScanResult | null> {
  const identifier = await db.customerIdentifier.findFirst({
    where: {
      kind: 'WALLET',
      normalizedValue: alias,
      customer: {
        anonymizedAt: null,
        walletPasses: { some: { status: 'ACTIVE' } },
      },
    },
    select: {
      customerId: true,
      customer: {
        select: { loyaltyAccount: { select: { id: true, active: true } } },
      },
    },
  });
  if (!identifier) return null;

  const account = identifier.customer.loyaltyAccount;
  const aggregate = account
    ? await db.loyaltyPointsEntry.aggregate({
        where: { accountId: account.id },
        _sum: { points: true },
      })
    : null;

  return {
    customerId: identifier.customerId,
    loyalty: {
      accountId: account?.id ?? null,
      accountActive: account?.active ?? false,
      balance: aggregate?._sum.points ?? 0,
    },
  };
}

/**
 * Attach a guest to an order that belongs to the DEVICE'S OWN BRANCH. The branch guard runs
 * first and returns null for anything outside it, so a cross-branch or cross-tenant order id
 * is indistinguishable from "not found" (the M5 `getOrderSettlementForBranch` rule) and can
 * never be used to probe another branch's order book. Both statements run inside the request
 * transaction the transport opened, so the guard and the attach cannot interleave.
 */
export async function attachCustomerForBranch(
  db: ScopedDb,
  input: { orderId: string; customerId: string; branchId: string }
) {
  const order = await db.restaurantOrder.findFirst({
    where: { id: input.orderId, branchId: input.branchId },
    select: { id: true },
  });
  if (!order) return null;

  const attached = await attachCustomerToOrder(db, {
    customerId: input.customerId,
    orderId: input.orderId,
  });
  return {
    orderId: attached.id,
    branchId: attached.branchId,
    customerId: attached.customerId,
    status: attached.status,
  };
}
