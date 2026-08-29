/**
 * M9-L2 — unit tests for the POS-terminal customer transport glue. These cover the pieces
 * that need no database: the strict schemas (unknown fields REJECTED, never stripped), the
 * masking that keeps raw guest PII off a pad, the branch object-scope guard that makes a
 * cross-branch order indistinguishable from a missing one, and the domain-error → HTTP
 * mapping that must not leak internals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { CustomerError } from './customers';
import {
  attachCustomerForBranch,
  customerAttachBody,
  customerErrorResponse,
  customerSearchQuery,
  maskCustomerIdentifier,
  resolveWalletScan,
  searchConnectedCustomers,
  walletScanQuery,
} from './terminal-customers';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findUniqueOrThrow: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

function makeDb() {
  const db = {
    restaurantCustomer: model(),
    customerIdentifier: model(),
    loyaltyPointsEntry: {
      ...model(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: null } }),
    },
    restaurantOrder: model(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db));
  return db;
}

let db: ReturnType<typeof makeDb>;
const scoped = () => db as unknown as ScopedDb;

beforeEach(() => {
  db = makeDb();
});

describe('strict input schemas', () => {
  it('rejects an unknown search parameter instead of silently ignoring it', () => {
    expect(customerSearchQuery.safeParse({ query: 'ali' }).success).toBe(true);
    expect(customerSearchQuery.safeParse({ query: 'ali', branchId: 'b1' }).success).toBe(false);
  });

  it('requires a deliberate lookup and caps the page, so the book cannot be dumped', () => {
    expect(customerSearchQuery.safeParse({ query: 'a' }).success).toBe(false);
    expect(customerSearchQuery.safeParse({ query: '  a  ' }).success).toBe(false);
    expect(customerSearchQuery.safeParse({ query: 'ali', limit: 10 }).success).toBe(true);
    expect(customerSearchQuery.safeParse({ query: 'ali', limit: 11 }).success).toBe(false);
    expect(customerSearchQuery.safeParse({ query: 'ali', limit: 0 }).success).toBe(false);
  });

  it('coerces a query-string limit, since search params arrive as text', () => {
    const parsed = customerSearchQuery.safeParse({ query: 'ali', limit: '5' });
    expect(parsed.success && parsed.data.limit).toBe(5);
  });

  it('takes only the two object ids on attach — never a caller-supplied scope', () => {
    expect(customerAttachBody.safeParse({ orderId: 'o1', customerId: 'c1' }).success).toBe(true);
    expect(
      customerAttachBody.safeParse({ orderId: 'o1', customerId: 'c1', branchId: 'b1' }).success
    ).toBe(false);
    expect(
      customerAttachBody.safeParse({ orderId: 'o1', customerId: 'c1', organizationId: 'org1' })
        .success
    ).toBe(false);
    expect(customerAttachBody.safeParse({ orderId: '', customerId: 'c1' }).success).toBe(false);
  });

  it('accepts only the DFW1 wallet barcode envelope', () => {
    const alias = `wla_${'0'.repeat(26)}`;
    expect(walletScanQuery.safeParse({ code: `DFW1:${alias}` }).success).toBe(true);
    expect(walletScanQuery.safeParse({ code: alias }).success).toBe(false);
    expect(walletScanQuery.safeParse({ code: `https://wallet.example/${alias}` }).success).toBe(
      false
    );
    expect(
      walletScanQuery.safeParse({ code: `DFW1:${alias}`, organizationId: 'org2' }).success
    ).toBe(false);
  });
});

describe('maskCustomerIdentifier', () => {
  it('keeps an email recognisable without disclosing a contactable address', () => {
    expect(maskCustomerIdentifier('EMAIL', 'ali@example.com')).toBe('a••@example.com');
    expect(maskCustomerIdentifier('EMAIL', 'a@example.com')).toBe('a•@example.com');
  });

  it('degrades to dots rather than revealing a malformed email', () => {
    expect(maskCustomerIdentifier('EMAIL', 'not-an-email')).toBe('•••••');
    expect(maskCustomerIdentifier('EMAIL', '@example.com')).toBe('•••••');
  });

  it('keeps only the last four digits of a phone number', () => {
    expect(maskCustomerIdentifier('PHONE', '+923001234567')).toBe('•••• 4567');
    expect(maskCustomerIdentifier('PHONE', '1234')).toBe('••••');
  });
});

describe('searchConnectedCustomers', () => {
  const row = {
    id: 'c1',
    displayName: 'Ali Raza',
    identifiers: [
      { id: 'i1', kind: 'EMAIL' as const, normalizedValue: 'ali@example.com' },
      { id: 'i2', kind: 'PHONE' as const, normalizedValue: '+923001234567' },
    ],
  };

  it('returns ids, a display name and MASKED identifiers only — no raw PII', async () => {
    db.restaurantCustomer.findMany.mockResolvedValue([row]);
    const [match] = await searchConnectedCustomers(scoped(), { query: 'ali' });

    expect(match).toEqual({
      customerId: 'c1',
      displayName: 'Ali Raza',
      identifiers: [
        { id: 'i1', kind: 'EMAIL', masked: 'a••@example.com' },
        { id: 'i2', kind: 'PHONE', masked: '•••• 4567' },
      ],
    });
    expect(JSON.stringify(match)).not.toContain('ali@example.com');
    expect(JSON.stringify(match)).not.toContain('+923001234567');
  });

  it('does not search or return wallet aliases through the PII-confirmation search flow', async () => {
    db.restaurantCustomer.findMany.mockResolvedValue([row]);
    await searchConnectedCustomers(scoped(), { query: 'ali' });

    const args = db.restaurantCustomer.findMany.mock.calls[0][0];
    expect(args.where.OR[3].identifiers.some.kind).toEqual({ in: ['EMAIL', 'PHONE'] });
    expect(args.select.identifiers.where.kind).toEqual({ in: ['EMAIL', 'PHONE'] });
  });

  it('never selects the back-office PII columns a terminal has no business holding', async () => {
    db.restaurantCustomer.findMany.mockResolvedValue([]);
    await searchConnectedCustomers(scoped(), { query: 'ali' });

    const select = db.restaurantCustomer.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('birthDate');
    expect(select).not.toHaveProperty('notes');
    expect(select).not.toHaveProperty('interactions');
    expect(select).not.toHaveProperty('consentEvents');
  });

  it('excludes anonymized guests and caps the page at the screen limit', async () => {
    db.restaurantCustomer.findMany.mockResolvedValue([]);
    await searchConnectedCustomers(scoped(), { query: 'ali', limit: 999 });

    const args = db.restaurantCustomer.findMany.mock.calls[0][0];
    expect(args.where.anonymizedAt).toBeNull();
    expect(args.take).toBe(10);
  });

  it('refuses to run a too-short query even when the schema is bypassed', async () => {
    expect(await searchConnectedCustomers(scoped(), { query: 'a' })).toEqual([]);
    expect(db.restaurantCustomer.findMany).not.toHaveBeenCalled();
  });
});

describe('resolveWalletScan (zero-PII)', () => {
  it('returns exactly the ids and live loyalty facts needed for attach/redeem', async () => {
    db.customerIdentifier.findFirst.mockResolvedValue({
      customerId: 'c1',
      customer: { loyaltyAccount: { id: 'la1', active: true } },
    });
    db.loyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: 240 } });

    const result = await resolveWalletScan(scoped(), `wla_${'0'.repeat(26)}`);
    expect(result).toEqual({
      customerId: 'c1',
      loyalty: { accountId: 'la1', accountActive: true, balance: 240 },
    });
    expect(Object.keys(result ?? {})).toEqual(['customerId', 'loyalty']);
    expect(Object.keys(result?.loyalty ?? {})).toEqual(['accountId', 'accountActive', 'balance']);
    expect(JSON.stringify(result)).not.toMatch(/displayName|email|phone|organizationId|branchId/);
  });

  it('fails closed for unknown, revoked, anonymized, and foreign aliases', async () => {
    db.customerIdentifier.findFirst.mockResolvedValue(null);

    await expect(resolveWalletScan(scoped(), `wla_${'1'.repeat(26)}`)).resolves.toBeNull();
    const where = db.customerIdentifier.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      kind: 'WALLET',
      normalizedValue: `wla_${'1'.repeat(26)}`,
      customer: { anonymizedAt: null, walletPasses: { some: { status: 'ACTIVE' } } },
    });
    expect(db.loyaltyPointsEntry.aggregate).not.toHaveBeenCalled();
  });

  it('returns a null account and zero balance without widening the response', async () => {
    db.customerIdentifier.findFirst.mockResolvedValue({
      customerId: 'c1',
      customer: { loyaltyAccount: null },
    });
    await expect(resolveWalletScan(scoped(), `wla_${'2'.repeat(26)}`)).resolves.toEqual({
      customerId: 'c1',
      loyalty: { accountId: null, accountActive: false, balance: 0 },
    });
  });
});

describe('attachCustomerForBranch (object scope)', () => {
  it('answers "not found" for an order outside the device branch and never runs the command', async () => {
    db.restaurantOrder.findFirst.mockResolvedValue(null);

    expect(
      await attachCustomerForBranch(scoped(), {
        orderId: 'other_branch_order',
        customerId: 'c1',
        branchId: 'branch_1',
      })
    ).toBeNull();
    // The guard short-circuits BEFORE the M8 command opens its transaction, so a
    // cross-branch id cannot be used to probe another branch's order book.
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('scopes the guard to the device branch, not to the order id alone', async () => {
    db.restaurantOrder.findFirst.mockResolvedValue(null);
    await attachCustomerForBranch(scoped(), {
      orderId: 'o1',
      customerId: 'c1',
      branchId: 'branch_1',
    });

    expect(db.restaurantOrder.findFirst.mock.calls[0][0].where).toEqual({
      id: 'o1',
      branchId: 'branch_1',
    });
  });

  it('attaches a guest to an in-branch order and returns the order scope', async () => {
    db.restaurantOrder.findFirst.mockResolvedValue({ id: 'o1' });
    db.$queryRaw.mockResolvedValue([{ id: 'c1', anonymizedAt: null }]);
    db.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });
    db.restaurantOrder.findUniqueOrThrow.mockResolvedValue({
      id: 'o1',
      branchId: 'branch_1',
      customerId: 'c1',
      status: 'OPEN',
    });

    expect(
      await attachCustomerForBranch(scoped(), {
        orderId: 'o1',
        customerId: 'c1',
        branchId: 'branch_1',
      })
    ).toEqual({ orderId: 'o1', branchId: 'branch_1', customerId: 'c1', status: 'OPEN' });
  });
});

describe('customerErrorResponse', () => {
  const status = (reason: ConstructorParameters<typeof CustomerError>[1]) =>
    customerErrorResponse(new CustomerError('boom', reason))?.status;

  it('maps a missing object onto 404 and a precondition onto 409', () => {
    expect(status('NOT_FOUND')).toBe(404);
    expect(status('INVALID_STATE')).toBe(409);
    expect(status('ANONYMIZED')).toBe(409);
    expect(status('DUPLICATE_IDENTIFIER')).toBe(409);
  });

  it('maps a malformed identifier onto 400', () => {
    expect(status('INVALID_IDENTIFIER')).toBe(400);
  });

  it('returns null for a non-domain error so the transport answers a generic 500', () => {
    expect(customerErrorResponse(new Error('connection reset'))).toBeNull();
  });

  it('carries the authored domain message and nothing else', async () => {
    const response = customerErrorResponse(new CustomerError('Order does not exist.', 'NOT_FOUND'));
    await expect(response?.json()).resolves.toEqual({ error: 'Order does not exist.' });
  });
});
