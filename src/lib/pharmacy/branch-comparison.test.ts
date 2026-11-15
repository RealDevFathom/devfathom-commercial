import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandCentre = vi.hoisted(() => vi.fn());
vi.mock('./reports', () => ({ readPharmacyOwnerCommandCentre: commandCentre }));
import { readPharmacyBranchComparison } from './branch-comparison';

describe('pharmacy branch comparison', () => {
  beforeEach(() => commandCentre.mockReset());

  it('matches branch fixtures and keeps estimated demand explicit', async () => {
    commandCentre
      .mockResolvedValueOnce({
        metrics: {
          salesMinor: 10_000,
          marginMinor: 2_500,
          expiryValueMinor30: 900,
          khataAgingMinor: 400,
        },
      })
      .mockResolvedValueOnce({
        metrics: {
          salesMinor: 20_000,
          marginMinor: 6_000,
          expiryValueMinor30: 300,
          khataAgingMinor: 100,
        },
      });
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce({ _sum: { estimatedValueMinor: 1_200 }, _count: { _all: 3 } })
      .mockResolvedValueOnce({ _sum: { estimatedValueMinor: null }, _count: { _all: 1 } });
    const result = await readPharmacyBranchComparison(
      { unfulfilledDemandEvent: { aggregate } } as never,
      {
        branches: [
          { id: 'north', name: 'North' },
          { id: 'south', name: 'South' },
        ],
        from: '2026-10-01',
        to: '2026-10-07',
      }
    );
    expect(result.label).toBe('Estimate');
    expect(result.rows).toEqual([
      {
        branchId: 'north',
        branchName: 'North',
        salesMinor: 10_000,
        marginMinor: 2_500,
        lostDemandEstimateMinor: 1_200,
        lostDemandRecordedEvents: 3,
        expiryAtRiskMinor: 900,
        khataAgingMinor: 400,
      },
      {
        branchId: 'south',
        branchName: 'South',
        salesMinor: 20_000,
        marginMinor: 6_000,
        lostDemandEstimateMinor: null,
        lostDemandRecordedEvents: 1,
        expiryAtRiskMinor: 300,
        khataAgingMinor: 100,
      },
    ]);
    expect(commandCentre).toHaveBeenNthCalledWith(1, expect.anything(), {
      branchIds: ['north'],
      from: '2026-10-01',
      to: '2026-10-07',
    });
  });

  it('bounds lost demand by workspace midnights in both reads', async () => {
    commandCentre.mockResolvedValue({
      metrics: { salesMinor: 0, marginMinor: 0, expiryValueMinor30: 0, khataAgingMinor: 0 },
    });
    const aggregate = vi
      .fn()
      .mockResolvedValue({ _sum: { estimatedValueMinor: null }, _count: { _all: 0 } });
    await readPharmacyBranchComparison({ unfulfilledDemandEvent: { aggregate } } as never, {
      branches: [{ id: 'north', name: 'North' }],
      from: '2026-10-01',
      to: '2026-10-07',
      timeZone: 'Asia/Karachi',
    });
    // 1–7 October on the Karachi clock: 19:00 UTC on 30 September to 19:00 UTC on 7 October.
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branchId: 'north',
          createdAt: {
            gte: new Date('2026-09-30T19:00:00.000Z'),
            lt: new Date('2026-10-07T19:00:00.000Z'),
          },
        },
      })
    );
    expect(commandCentre).toHaveBeenCalledWith(expect.anything(), {
      branchIds: ['north'],
      from: '2026-10-01',
      to: '2026-10-07',
      timeZone: 'Asia/Karachi',
    });
  });
});
