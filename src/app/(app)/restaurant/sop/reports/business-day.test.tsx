import { render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import Oversight from '../oversight/page';
import Reports from './page';

const work = vi.hoisted(() => ({
  report: vi.fn().mockResolvedValue({ total: 0 }),
  score: vi.fn().mockReturnValue({}),
  branchClock: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi', businessDayCutoff: '00:00' }),
}));
vi.mock('@/lib/abac', () => ({ can: () => true, subjectFromSession: () => ({}) }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: async () => ({
    session: { user: { organizationId: 'org' } },
    organization: { id: 'org', timezone: 'UTC' },
    db: { restaurantBranch: { findFirst: work.branchClock } },
  }),
}));
vi.mock('@/server/routers/restaurant-sop-execution', () => ({
  restaurantSopExecutionRouter: {
    createCaller: () => ({
      reportBranches: async () => [{ id: 'branch', name: 'Karachi' }],
      report: work.report,
    }),
  },
}));
vi.mock('@/lib/trpc', () => {
  const query = { useQuery: () => ({}) };
  const mutation = { useMutation: () => ({}) };
  return {
    trpc: {
      useUtils: () => ({}),
      restaurantStaff: { listBranches: query, listDirectory: query },
      restaurantSop: {
        listEscalationPolicies: query,
        scoreReport: { useQuery: work.score },
        listRecentOccurrences: query,
        occurrenceAuditTrail: query,
        createEscalationPolicy: mutation,
        setEscalationPolicyActive: mutation,
        upsertEscalationStep: mutation,
        removeEscalationStep: mutation,
      },
    },
  };
});
afterEach(() => vi.useRealTimers());
it('includes the 00:30 Karachi business day in the selected SOP branch report', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T00:30:00+05:00'));
  await Reports({
    searchParams: Promise.resolve({
      branch: undefined,
      from: undefined,
      to: undefined,
      department: undefined,
    }),
  });
  expect(work.report).toHaveBeenCalledWith({
    branchId: 'branch',
    from: '2026-10-27',
    to: '2026-11-02',
    department: undefined,
  });
});
it('includes the 00:30 Karachi business day in the organization-wide oversight score', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T00:30:00+05:00'));
  const entitlements: EntitlementView = {
    organizationId: 'org',
    enabledModules: ['restaurant-sop'],
    modules: [],
    seatLimit: 5,
    activeSeats: 1,
    limits: {},
    timeZone: 'Asia/Karachi',
  };
  render(
    <EntitlementsProvider value={entitlements}>
      <Oversight />
    </EntitlementsProvider>
  );
  expect(work.score).toHaveBeenCalledWith(
    { from: '2026-10-03', to: '2026-11-02', branchId: null },
    { enabled: true }
  );
});
