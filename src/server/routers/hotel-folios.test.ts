import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/hotel-property-scope', async (original) => ({
  ...(await original<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: mocks.scope,
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  annotateAudit: vi.fn(),
}));
vi.mock('../trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<Record<string, unknown>>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    adminProcedure: t.procedure,
    capabilityProcedure: () => t.procedure,
  };
});

import { reservationRequestHash } from '@/lib/hotel/reservations';
import { folioPostExtraInput, hotelFoliosRouter, mapLedgerError } from './hotel-folios';

type Responder = (sql: string, values: unknown[]) => unknown;

/** A transaction client whose `$queryRaw` answers by the SQL it is handed. */
function harness(respond: Responder) {
  const statements: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: unknown, ...rest: unknown[]) => {
      const sql = Array.isArray(query)
        ? (query as readonly string[]).join('?')
        : (query as { strings: readonly string[] }).strings.join('?');
      const values = Array.isArray(query) ? rest : (query as { values: unknown[] }).values;
      statements.push(sql);
      return respond(sql, values) ?? [];
    }),
    hotelProperty: {
      findFirst: vi.fn(async () => ({
        branchId: 'branch_1',
        organizationId: 'org_1',
        currency: 'PKR',
      })),
    },
  };
  const db = { $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)) };
  const context = {
    session: { user: { id: 'user_1', organizationId: 'org_1' } },
    entitlements: { organizationId: 'org_1' },
    requestMeta: { ip: null },
    db,
  };
  return { statements, tx, caller: hotelFoliosRouter.createCaller(context as never) };
}

const posting = {
  branchId: 'branch_1',
  folioId: 'folio_1',
  catalogItemId: 'extra_1',
  quantity: 2,
  idempotencyKey: 'post-extra-0001',
};
const requestHash = reservationRequestHash({
  branchId: 'branch_1',
  folioId: 'folio_1',
  catalogItemId: 'extra_1',
  quantity: 2,
});

beforeEach(() => {
  mocks.scope.mockReset();
  mocks.scope.mockResolvedValue({ organizationId: 'org_1', branchId: 'branch_1' });
});

describe('hotelFolios.postExtra idempotency', () => {
  it('requires an idempotency key and still refuses client money', () => {
    expect(folioPostExtraInput.safeParse(posting).success).toBe(true);
    expect(folioPostExtraInput.safeParse({ ...posting, idempotencyKey: undefined }).success).toBe(
      false
    );
    expect(folioPostExtraInput.safeParse({ ...posting, grossMinor: 1 }).success).toBe(false);
    expect(folioPostExtraInput.safeParse({ ...posting, quantity: 2 ** 31 }).success).toBe(false);
  });

  it('posts once and records the key against the new entry', async () => {
    const { statements, caller } = harness((sql) => {
      if (sql.includes('FROM hotel_operation_idempotency_keys')) return [];
      if (sql.includes('FROM hotel_extras')) return [{ unitMinor: 500, taxBasisPoints: 0 }];
      if (sql.includes('INSERT INTO hotel_folio_entries'))
        return [{ id: 'entry_new', grossMinor: BigInt(1_000) }];
      if (sql.includes('INSERT INTO hotel_operation_idempotency_keys')) return [{ id: 'key_1' }];
      return [];
    });
    await expect(caller.postExtra(posting)).resolves.toMatchObject({ id: 'entry_new' });
    expect(
      statements.filter((sql) => sql.includes('INSERT INTO hotel_folio_entries'))
    ).toHaveLength(1);
    expect(
      statements.filter((sql) => sql.includes('INSERT INTO hotel_operation_idempotency_keys'))
    ).toHaveLength(1);
  });

  it('replays an exact retry without posting a second charge', async () => {
    const { statements, caller } = harness((sql) => {
      if (sql.includes('FROM hotel_operation_idempotency_keys'))
        return [{ requestHash, resultId: 'entry_1' }];
      if (sql.includes('FROM hotel_folio_entries'))
        return [{ id: 'entry_1', grossMinor: BigInt(1_000) }];
      return [];
    });
    await expect(caller.postExtra(posting)).resolves.toMatchObject({ id: 'entry_1' });
    expect(statements.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('refuses the same key for a different posting', async () => {
    const { statements, caller } = harness((sql) => {
      if (sql.includes('FROM hotel_operation_idempotency_keys'))
        return [{ requestHash, resultId: 'entry_1' }];
      return [];
    });
    await expect(caller.postExtra({ ...posting, quantity: 3 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(statements.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });
});

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('hotelFolios ledger error mapping', () => {
  it('maps the reversal guard and malformed pricing to client errors, not a 500', () => {
    const sqlError = (code: string) => Object.assign(new Error('db'), { code });
    expect(caught(() => mapLedgerError(sqlError('23514')))).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => mapLedgerError(sqlError('23505')))).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => mapLedgerError(new Error('Invalid tax rate.')))).toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(
      caught(() =>
        mapLedgerError(new Error('Folio entry is unavailable on an open folio of this property.'))
      )
    ).toMatchObject({ code: 'NOT_FOUND' });
    const forbidden = new TRPCError({ code: 'FORBIDDEN' });
    expect(caught(() => mapLedgerError(forbidden))).toBe(forbidden);
  });
});
