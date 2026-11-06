import { beforeEach, expect, it, vi } from 'vitest';
import {
  runRestaurantJob,
  resolveRestaurantJobHandler,
  restaurantJobHandlers,
} from '@/lib/restaurant/job-handlers';
import {
  coreRestaurantJobHandlers,
  runRestaurantJob as runComposedJob,
} from '@/lib/restaurant/job-handlers-core';
import { runRestaurantWorkerTick } from '@/lib/restaurant/job-runner';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';

const mock = vi.hoisted(() => ({
  reset: vi.fn(),
  coreMenu: vi.fn(),
  legacyMenu: vi.fn(),
  raw: vi.fn(),
  recover: vi.fn(),
  drain: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('@/lib/demo/jobs', () => ({ demoResetJobHandler: mock.reset }));
vi.mock('@/lib/restaurant/webhook-inbox', () => ({
  WEBHOOK_PROCESS_JOB_TYPE: 'inbound',
  processInboundWebhookHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/sop-occurrence-generation', () => ({
  SOP_GENERATE_OCCURRENCES_JOB: 'occurrences',
  generateSopOccurrencesHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/sop-late-missed', () => ({
  SOP_LATE_MISSED_JOB: 'late',
  sopLateMissedHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/sop-escalation', () => ({
  SOP_ESCALATION_JOB: 'escalation',
  sopEscalationHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/notification-fanout', () => ({
  NOTIFICATION_FANOUT_JOB: 'fanout',
  notificationFanoutHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/loyalty-expiry', () => ({
  LOYALTY_EXPIRY_JOB: 'loyalty',
  loyaltyExpiryHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/insight-rollups', () => ({
  INSIGHTS_ROLLUP_DAY_JOB: 'rollup',
  rollupDayHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/menu-import', () => ({
  MENU_IMPORT_EXTRACT_JOB: 'menu',
  menuImportExtractHandler: mock.coreMenu,
}));
vi.mock('@/lib/restaurant/menu-import-legacy', () => ({
  MENU_IMPORT_EXTRACT_JOB: 'menu',
  menuImportExtractHandler: mock.legacyMenu,
}));
vi.mock('@/lib/restaurant/notification-webhook', () => ({
  NOTIFICATION_WEBHOOK_JOB_TYPE: 'notification',
  notificationWebhookJobHandler: vi.fn(),
}));
vi.mock('@/lib/restaurant/scheduler', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/restaurant/scheduler')>();
  return { ...original, recoverStaleJobs: mock.recover, drainDueJobs: mock.drain };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (work: (db: unknown) => unknown) => work({ $queryRaw: mock.raw }),
  withTenantDb: vi.fn(),
  createTenantDb: vi.fn(),
}));
vi.mock('@/lib/restaurant/outbox-dispatcher', () => ({
  dispatchOutboxBatch: mock.dispatch,
  restaurantOutboxConsumers: {},
}));
const emptyJobs = { claimed: 0, succeeded: 0, retried: 0, dead: 0, failed: 0, released: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mock.raw.mockResolvedValue([]);
  mock.recover.mockResolvedValue(0);
  mock.drain.mockResolvedValue(emptyJobs);
  mock.dispatch.mockResolvedValue({ dispatched: 0, retried: 0, dead: 0, skipped: 0 });
});
it('preserves legacy reset registration and explicitly composed handler behavior', async () => {
  const context = { job: { type: 'demo-reset' }, db: {} } as RestaurantJobContext;
  expect(resolveRestaurantJobHandler('demo-reset')).toBe(mock.reset);
  expect(Object.keys(restaurantJobHandlers).sort()).toEqual(
    [
      ...Object.keys(coreRestaurantJobHandlers),
      'demo-reset',
      'pharmacy.sop.autoGenerate',
      'pharmacy.sop.autoGenerateBranch',
    ].sort()
  );
  await runRestaurantJob(context);
  expect(mock.reset).toHaveBeenCalledExactlyOnceWith(context);
  const handler = vi.fn();
  await runComposedJob(context, { 'demo-reset': handler });
  expect(handler).toHaveBeenCalledExactlyOnceWith(context);
});
it('unknown handlers fail instead of silently succeeding in both compositions', async () => {
  const context = { job: { type: 'unknown' }, db: {} } as RestaurantJobContext;
  await expect(runRestaurantJob(context)).rejects.toThrow(
    'No restaurant job handler is registered for type "unknown".'
  );
  await expect(runComposedJob(context, {})).rejects.toThrow(
    'No restaurant job handler is registered'
  );
});
it('retains reset exclusion in privileged discovery', async () => {
  await runRestaurantWorkerTick({ workerId: 'unit-worker' });
  const query = mock.raw.mock.calls[0][0];
  expect(query.values).toContain('demo-reset');
  expect(query.strings.join('?')).toContain('"type" <> ?');
});
it('retains reset exclusions in stale recovery and drain inside the selected tenant', async () => {
  const runInOrg = vi.fn(async (_organizationId, work) => work({}));
  await runRestaurantWorkerTick({
    workerId: 'unit-worker',
    discoverOrganizations: async () => ['organization'],
    runInOrg,
    outboxClient: () => ({}) as never,
  });
  expect(mock.recover).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ excludeJobType: 'demo-reset' })
  );
  expect(mock.drain).toHaveBeenCalledWith(
    expect.objectContaining({ excludeJobType: 'demo-reset' })
  );
  expect(runInOrg.mock.calls.every((call) => call[0] === 'organization')).toBe(true);
});

it('legacy overrides the core menu handler after the base spread while core stays inert', async () => {
  const context = { job: { type: 'menu' }, db: {} } as RestaurantJobContext;
  expect(coreRestaurantJobHandlers.menu).toBe(mock.coreMenu);
  expect(restaurantJobHandlers.menu).toBe(mock.legacyMenu);
  await runRestaurantJob(context);
  expect(mock.legacyMenu).toHaveBeenCalledExactlyOnceWith(context);
  expect(mock.coreMenu).not.toHaveBeenCalled();
  await runComposedJob(context, coreRestaurantJobHandlers);
  expect(mock.coreMenu).toHaveBeenCalledExactlyOnceWith(context);
});
