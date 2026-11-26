/**
 * DEV-860: a deliberate refusal may name its reason next to its words. The tenant
 * `errorFormatter` publishes a `RefusalReason` cause as `data.reason`, through the real
 * transport, and publishes nothing for any other cause.
 */
import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

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

import { CounterApprovalChoice } from '@/lib/pharmacy/counter-approval-choice';
import { RefusalReason, refusalReasonOf } from './refusal-reason';
import { publicProcedure, router } from './trpc';

const OUTSIDE = 'Branch is outside your scope.';

const testRouter = router({
  approvalChoice: publicProcedure.query(() => {
    const choice = new CounterApprovalChoice(
      ['eligible-a', 'eligible-b'],
      ['fixture-a', 'fixture-b']
    );
    throw new TRPCError({ code: 'FORBIDDEN', message: choice.message, cause: choice });
  }),
  named: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: OUTSIDE,
      cause: new RefusalReason('BRANCH_NOT_ASSIGNED'),
    });
  }),
  unnamed: publicProcedure.query(() => {
    throw new TRPCError({ code: 'FORBIDDEN', message: OUTSIDE });
  }),
  otherCause: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: OUTSIDE,
      cause: new Error('BRANCH_NOT_ASSIGNED'),
    });
  }),
  malformed: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: OUTSIDE,
      cause: new RefusalReason('branch org-2 belongs to someone else'),
    });
  }),
});

async function call(path: string) {
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(`http://localhost/api/trpc/${path}`),
    router: testRouter,
    createContext: () => ({}) as never,
  });
  const body = (await response.json()) as {
    error: { json: { message: string; data: Record<string, unknown> } };
  };
  return body.error.json;
}

describe('refusal reasons (DEV-860)', () => {
  it('publishes a named reason beside the refusal’s own words', async () => {
    const error = await call('named');
    expect(error.message).toBe(OUTSIDE);
    expect(error.data).toMatchObject({ code: 'FORBIDDEN', reason: 'BRANCH_NOT_ASSIGNED' });
  });

  it.each(['unnamed', 'otherCause', 'malformed'])('publishes no reason for %s', async (path) => {
    const error = await call(path);
    expect(error.message).toBe(OUTSIDE);
    expect(error.data).not.toHaveProperty('reason');
  });

  it('reads only reason codes from a RefusalReason', () => {
    expect(refusalReasonOf(new RefusalReason('PROFILE_MISSING'))).toBe('PROFILE_MISSING');
    expect(refusalReasonOf(new RefusalReason('Profile missing'))).toBeNull();
    expect(refusalReasonOf(new Error('PROFILE_MISSING'))).toBeNull();
    expect(refusalReasonOf(undefined)).toBeNull();
  });
});

it('returns only the matched profile IDs on the deliberate approval choice', async () => {
  const error = await call('approvalChoice');
  expect(error.message).toBe(
    'Which person is approving? Choose their name and wait for their next authenticator code, then enter it.'
  );
  expect(error.data.matchingStaffProfileIds).toEqual(['eligible-a', 'eligible-b']);
  expect(error.data.choiceProofs).toEqual(['fixture-a', 'fixture-b']);
  expect((await call('otherCause')).data).not.toHaveProperty('matchingStaffProfileIds');
});
