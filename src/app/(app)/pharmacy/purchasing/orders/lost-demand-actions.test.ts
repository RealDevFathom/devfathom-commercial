/**
 * DEV-80 — the trigger-settings form posts rupees and percentages; the router
 * stores minor units and basis points. The conversion is exact and a bad value
 * names its field instead of reaching the server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setLostDemandTriggerSettings: vi.fn(),
  purchasingCaller: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({ pharmacyPurchasingRouter: {} }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('../_lib/console', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/console')>()),
  purchasingCaller: mocks.purchasingCaller,
}));

import { saveLostDemandTriggers } from './lost-demand-actions';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID = {
  branchId: 'branch_a',
  requestCountThreshold: '4',
  requestWindowDays: '7',
  estimatedLossThreshold: '12500.50',
  lossWindowDays: '30',
  walkOutRatePercent: '12.5',
  forecastWindowDays: '30',
  safetyStockDays: '5',
  defaultLeadTimeDays: '2',
};

beforeEach(() => {
  mocks.setLostDemandTriggerSettings.mockReset().mockResolvedValue({});
  mocks.purchasingCaller
    .mockReset()
    .mockResolvedValue({ setLostDemandTriggerSettings: mocks.setLostDemandTriggerSettings });
});

describe('saveLostDemandTriggers', () => {
  it('converts rupees to minor units and percent to basis points exactly', async () => {
    const target = await saveLostDemandTriggers(form(VALID));
    expect(mocks.setLostDemandTriggerSettings).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch_a',
      settings: {
        requestCountThreshold: 4,
        requestWindowDays: 7,
        estimatedLossThresholdMinor: 1_250_050,
        lossWindowDays: 30,
        walkOutRateThresholdBps: 1_250,
        forecastWindowDays: 30,
        safetyStockDays: 5,
        defaultLeadTimeDays: 2,
      },
    });
    const params = new URL(target, 'http://x').searchParams;
    expect(params.get('kind')).toBe('success');
    expect(params.get('branch')).toBe('branch_a');
  });

  it.each([
    ['walkOutRatePercent', '10%'],
    ['estimatedLossThreshold', '1,000'],
    ['requestCountThreshold', '2.5'],
  ])('names %s when it is malformed and writes nothing', async (name, value) => {
    const target = await saveLostDemandTriggers(form({ ...VALID, [name]: value }));
    const params = new URL(target, 'http://x').searchParams;
    expect(params.get('kind')).toBe('error');
    expect(params.get('field')).toBe(name);
    expect(mocks.setLostDemandTriggerSettings).not.toHaveBeenCalled();
  });
});
