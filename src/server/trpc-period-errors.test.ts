/**
 * DEV-877: a posting refused because its accounting period is closed reaches
 * every router as a typed BAD_REQUEST `PERIOD_CLOSED`, through the real tRPC
 * transport and its outermost middleware. Without the mapping each of these
 * escaped as an INTERNAL_SERVER_ERROR (withheld in production).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Prisma } from '@/generated/prisma/client';
import { FinancePostingError } from '@/lib/finance/journal';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { publicProcedure, router } from './trpc';
import { isAccountingPeriodClosedError } from './trpc-period-errors';

/** What Prisma reports when the database period trigger refuses an insert. */
const TRIGGER_MESSAGE =
  '\nInvalid `prisma.financeJournalEntry.create()` invocation:\n\n\nDatabase error. Code: `23514`. Message: `PHARMACY_ACCOUNTING_PERIOD_CLOSED`';

function driverAdapterError(message: string) {
  const error = new Error(message);
  error.name = 'DriverAdapterError';
  return error;
}

const testRouter = router({
  journal: publicProcedure.mutation(() => {
    throw new FinancePostingError('PERIOD_CLOSED');
  }),
  trigger: publicProcedure.mutation(() => {
    throw new Prisma.PrismaClientKnownRequestError(TRIGGER_MESSAGE, {
      code: 'P2010',
      clientVersion: 'test',
    });
  }),
  rawTrigger: publicProcedure.mutation(() => {
    throw driverAdapterError('PHARMACY_ACCOUNTING_PERIOD_CLOSED');
  }),
  unbalanced: publicProcedure.mutation(() => {
    throw new FinancePostingError('UNBALANCED');
  }),
  deliberate: publicProcedure.mutation(() => {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only a manager can do this.',
      cause: new FinancePostingError('PERIOD_CLOSED'),
    });
  }),
});

async function call(path: string) {
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(`http://localhost/api/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    router: testRouter,
    createContext: () => ({}) as never,
  });
  const body = (await response.json()) as {
    error: { json: { message: string; data: { code: string; httpStatus: number } } };
  };
  return body.error.json;
}

describe.each(['development', 'production'])('DEV-877 closed-period refusals (%s)', (env) => {
  beforeEach(() => vi.stubEnv('NODE_ENV', env));
  afterEach(() => vi.unstubAllEnvs());

  it.each(['journal', 'trigger', 'rawTrigger'])(
    'maps a %s period refusal to BAD_REQUEST PERIOD_CLOSED',
    async (path) => {
      const error = await call(path);
      expect(error.data).toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 });
      expect(error.message).toBe('PERIOD_CLOSED');
      expect(JSON.stringify(error)).not.toMatch(/prisma|financeJournalEntry/i);
    }
  );

  it('leaves other posting failures unexpected', async () => {
    const error = await call('unbalanced');
    expect(error.data.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('keeps a deliberate TRPCError with a period cause unchanged', async () => {
    const error = await call('deliberate');
    expect(error.data.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Only a manager can do this.');
  });
});

describe('isAccountingPeriodClosedError', () => {
  it('recognises only period refusals', () => {
    expect(isAccountingPeriodClosedError(new FinancePostingError('PERIOD_CLOSED'))).toBe(true);
    expect(
      isAccountingPeriodClosedError(driverAdapterError('PHARMACY_ACCOUNTING_PERIOD_CLOSED'))
    ).toBe(true);
    expect(isAccountingPeriodClosedError(new FinancePostingError('IDEMPOTENCY_CONFLICT'))).toBe(
      false
    );
    // A plain error that merely mentions the token is not a database refusal.
    expect(isAccountingPeriodClosedError(new Error('PHARMACY_ACCOUNTING_PERIOD_CLOSED'))).toBe(
      false
    );
    expect(isAccountingPeriodClosedError('PERIOD_CLOSED')).toBe(false);
  });
});
