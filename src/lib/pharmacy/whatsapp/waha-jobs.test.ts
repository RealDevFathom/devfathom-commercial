// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { runSenderJob } from './waha-jobs';

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (fn: (db: unknown) => unknown) =>
    fn({
      organization: {
        findMany: async () => [{ id: 'business-a' }, { id: 'business-b' }, { id: 'business-c' }],
      },
    }),
}));
afterEach(() => vi.unstubAllEnvs());
it('preserves the scheduler summary and the invocation limit across businesses', async () => {
  vi.stubEnv('PHARMACY_WHATSAPP_PROVIDER', 'waha');
  const limits: number[] = [];
  const result = await runSenderJob(3, async ({ limit, config }) => {
    if (!config?.organizationId) throw new Error('missing tenant');
    limits.push(limit);
    const scanned = Math.min(2, limit);
    return {
      configured: true,
      scanned,
      sent: scanned,
      configurationErrors: ['synthetic'],
      sms: { prepared: 1 },
    };
  });
  expect(result).toEqual({
    configured: true,
    scanned: 3,
    sent: 3,
    configurationErrors: ['synthetic'],
    sms: { prepared: 2 },
  });
  expect(limits).toEqual([3, 1]);
});
