import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  evaluateMarketingBlockRate,
  isQuietHour,
  MARKETING_SEND_POLICY_DEFAULTS,
  marketingPauseSignal,
  marketingPolicyCapReason,
  marketingSendPolicyInput,
  pauseMarketingSending,
  readMarketingSendPolicy,
  resumeMarketingSending,
  updateMarketingSendPolicy,
} from './marketing-send-policy';

const now = new Date('2026-10-06T07:00:00Z');

function database(row: Record<string, unknown> | null, counts = { blocks: 0, delivered: 0 }) {
  return {
    pharmacyMarketingSendPolicy: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: row?.pausedAt ? 1 : 0 })),
    },
    patientConsent: { count: vi.fn(async () => counts.blocks) },
    pharmacyCampaignDeliveryEvent: { count: vi.fn(async () => counts.delivered) },
    pharmacyCampaignCapture: { count: vi.fn(async () => 0) },
  };
}
const asDb = (mock: ReturnType<typeof database>) => mock as unknown as ScopedDb;

describe('marketing send policy defaults', () => {
  it('defaults to 1 per week, 2 per month and 22:00-09:00 quiet hours', async () => {
    expect(await readMarketingSendPolicy(asDb(database(null)), 'org-a')).toMatchObject({
      weeklyMax: 1,
      monthlyMax: 2,
      quietStartHour: 22,
      quietEndHour: 9,
      pausedAt: null,
    });
  });
  it.each([
    [21, false],
    [22, true],
    [0, true],
    [8, true],
    [9, false],
    [15, false],
  ])('treats hour %i as quiet=%s under the defaults', (hour, quiet) => {
    const { quietStartHour, quietEndHour } = MARKETING_SEND_POLICY_DEFAULTS;
    expect(isQuietHour(hour, quietStartHour, quietEndHour)).toBe(quiet);
  });
  it('rejects a weekly cap above the monthly cap and unknown fields', () => {
    const base = {
      branchId: 'branch-a',
      weeklyMax: 1,
      monthlyMax: 2,
      quietStartHour: 22,
      quietEndHour: 9,
      blockRatePauseBps: 200,
      blockRateMinSample: 50,
    };
    expect(marketingSendPolicyInput.safeParse(base).success).toBe(true);
    expect(marketingSendPolicyInput.safeParse({ ...base, weeklyMax: 3 }).success).toBe(false);
    expect(marketingSendPolicyInput.safeParse({ ...base, pausedAt: null }).success).toBe(false);
  });
});

describe('marketing policy caps', () => {
  it('counts both windows across campaigns and excludes the current capture', async () => {
    const mock = database(null);
    mock.pharmacyCampaignCapture.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    expect(
      await marketingPolicyCapReason(
        asDb(mock),
        'org-a',
        'customer-a',
        { weeklyMax: 1, monthlyMax: 2 },
        now,
        'capture-a'
      )
    ).toBe('FREQUENCY_CAP');
    expect(mock.pharmacyCampaignCapture.count).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: 'org-a',
        customerId: 'customer-a',
        channel: 'WHATSAPP',
        id: { not: 'capture-a' },
        capturedAt: { gte: new Date('2026-09-29T07:00:00Z'), lte: now },
      },
    });
    expect(mock.pharmacyCampaignCapture.count).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({
        capturedAt: { gte: new Date('2026-09-06T07:00:00Z'), lte: now },
      }),
    });
  });
});

describe('quality auto-pause', () => {
  it.each([
    ['phone_number_quality_update', { event: 'DOWNGRADE' }, 'QUALITY_DROP'],
    ['phone_number_quality_update', { event: 'FLAGGED' }, 'QUALITY_DROP'],
    ['account_update', { new_quality_score: 'yellow' }, 'QUALITY_DROP'],
    ['account_update', { event: 'ACCOUNT_VIOLATION' }, 'ACCOUNT_RESTRICTION'],
  ])('pauses on %s %j', (field, value, reason) => {
    expect(marketingPauseSignal(field, value)).toMatchObject({ reason });
  });
  it.each([
    ['phone_number_quality_update', { event: 'UPGRADE' }],
    ['account_update', { quality_rating: 'GREEN' }],
    ['messages', { event: 'DOWNGRADE' }],
    ['account_update', null],
  ])('ignores %s %j', (field, value) => {
    expect(marketingPauseSignal(field, value)).toBeNull();
  });
  it('keeps no phone number in the pause evidence', () => {
    const signal = marketingPauseSignal('phone_number_quality_update', {
      display_phone_number: '923001234567',
      event: 'DOWNGRADE',
    });
    expect(JSON.stringify(signal)).not.toContain('923001234567');
  });
  it('pauses once and keeps the original evidence', async () => {
    const fresh = database(null);
    expect(
      await pauseMarketingSending(
        asDb(fresh),
        'org-a',
        { reason: 'QUALITY_DROP', evidence: { version: 1 } },
        now
      )
    ).toBe('PAUSED');
    expect(fresh.pharmacyMarketingSendPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a' },
        update: expect.objectContaining({ pausedAt: now, pauseReason: 'QUALITY_DROP' }),
      })
    );
    const paused = database({ pausedAt: now });
    expect(
      await pauseMarketingSending(asDb(paused), 'org-a', { reason: 'X', evidence: {} }, now)
    ).toBe('ALREADY_PAUSED');
    expect(paused.pharmacyMarketingSendPolicy.upsert).not.toHaveBeenCalled();
  });
});

describe('block-rate auto-pause', () => {
  it('waits for the minimum sample', async () => {
    const mock = database(null, { blocks: 10, delivered: 49 });
    expect(await evaluateMarketingBlockRate(asDb(mock), 'org-a', now)).toBe('INSUFFICIENT_SAMPLE');
    expect(mock.pharmacyMarketingSendPolicy.upsert).not.toHaveBeenCalled();
  });
  it('stays open below the threshold', async () => {
    const mock = database(null, { blocks: 1, delivered: 100 });
    expect(await evaluateMarketingBlockRate(asDb(mock), 'org-a', now)).toBe('WITHIN_THRESHOLD');
  });
  it('pauses when STOP revocations reach the configured rate', async () => {
    const mock = database(null, { blocks: 2, delivered: 100 });
    expect(await evaluateMarketingBlockRate(asDb(mock), 'org-a', now)).toBe('PAUSED');
    expect(mock.pharmacyMarketingSendPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          pauseReason: 'BLOCK_RATE',
          pauseEvidence: expect.objectContaining({ rateBps: 200, thresholdBps: 200 }),
        }),
      })
    );
    expect(mock.patientConsent.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        purpose: 'MARKETING',
        channel: 'WHATSAPP',
        granted: false,
        recordedAt: { gte: new Date('2026-09-29T07:00:00Z'), lte: now },
      },
    });
  });
  it('uses a configured threshold', async () => {
    const mock = database({ blockRatePauseBps: 500 }, { blocks: 2, delivered: 100 });
    expect(await evaluateMarketingBlockRate(asDb(mock), 'org-a', now)).toBe('WITHIN_THRESHOLD');
  });
});

describe('owner configuration', () => {
  it('stores validated settings with the acting owner', async () => {
    const mock = database(null);
    await updateMarketingSendPolicy(asDb(mock), 'org-a', 'owner-a', {
      weeklyMax: 1,
      monthlyMax: 3,
      quietStartHour: 21,
      quietEndHour: 9,
      blockRatePauseBps: 300,
      blockRateMinSample: 100,
    });
    expect(mock.pharmacyMarketingSendPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ monthlyMax: 3, updatedByUserId: 'owner-a' }),
      })
    );
    await expect(
      updateMarketingSendPolicy(asDb(mock), 'org-a', 'owner-a', {
        weeklyMax: 5,
        monthlyMax: 2,
        quietStartHour: 22,
        quietEndHour: 9,
        blockRatePauseBps: 200,
        blockRateMinSample: 50,
      })
    ).rejects.toThrow();
  });
  it('resumes only a paused organization and records the owner', async () => {
    const mock = database({ pausedAt: now });
    expect(await resumeMarketingSending(asDb(mock), 'org-a', 'owner-a', now)).toEqual({
      resumed: true,
    });
    expect(mock.pharmacyMarketingSendPolicy.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', pausedAt: { not: null } },
      data: { pausedAt: null, pauseReason: null, resumedAt: now, resumedByUserId: 'owner-a' },
    });
  });
});
