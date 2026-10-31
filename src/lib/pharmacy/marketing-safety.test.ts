import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { MarketingWorkflowError } from './marketing-service';
import { parseMarketingQualityUpdates, requireMarketingQuality } from './marketing-safety';

const value = { new_quality_score: 'RED' };
function payload(entry: Record<string, unknown> = {}, update: Record<string, unknown> = value) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'account-a',
        time: 1790000000,
        changes: [{ field: 'account_update', value: update }],
        ...entry,
      },
    ],
  };
}
const parse = (body: unknown) => parseMarketingQualityUpdates(body, 'sender-a', 'account-a');

describe('marketing quality evidence', () => {
  it('accepts account-level quality evidence only for the explicitly bound account', () => {
    expect(parse(payload())).toEqual([
      {
        quality: 'RED',
        paused: true,
        reason: 'ACCOUNT_QUALITY_RED',
        occurredAt: new Date(1790000000000),
        eventKey: expect.any(String),
      },
    ]);
    expect(parse(payload({ id: 'foreign-account' }))).toEqual([]);
    expect(
      parse(payload({}, { event: 'ACCOUNT_VIOLATION', waba_info: { waba_id: 'foreign-account' } }))
    ).toEqual([]);
    expect(parseMarketingQualityUpdates(payload(), 'sender-a')).toEqual([]);
    expect(parseMarketingQualityUpdates(payload(), '', 'account-a')).toEqual([]);
  });

  it.each([
    { phone_number_id: 'foreign-sender' },
    { phone_number_id: '' },
    { phone_number: 'foreign-sender' },
    { phone_number_id: 'sender-a', phone_number: 'foreign-sender' },
  ])('rejects contradictory sender evidence: %j', (sender) => {
    expect(parse(payload({}, { ...value, ...sender }))).toEqual([]);
  });

  it.each([undefined, null, 0, -1, 1.5, 'invalid', Infinity, 8_640_000_000_001])(
    'ignores quality evidence without a valid provider timestamp: %s',
    (time) => {
      expect(parse(payload({ time }))).toEqual([]);
    }
  );

  it('requires account identity and the expected webhook object', () => {
    expect(parse(payload({ id: undefined }))).toEqual([]);
    expect(parse({ ...payload(), object: 'foreign_object' })).toEqual([]);
    expect(parse({ entry: payload().entry })).toEqual([]);
  });

  it('keeps stable evidence identity and provider time across retries', () => {
    const first = parse(payload())[0];
    expect(parse(JSON.parse(JSON.stringify(payload())))[0]).toEqual(first);
    expect(parse(payload({ time: '1790000000' }))[0]).toEqual(first);
    expect(parse(payload({ time: 1790000001 }))[0].eventKey).not.toBe(first.eventKey);
    expect(parse(payload({}, { new_quality_score: 'GREEN' }))[0].eventKey).not.toBe(first.eventKey);
  });

  it.each(['YELLOW', 'RED', 'GREEN'])('retains the %s quality transition', (quality) => {
    expect(parse(payload({}, { new_quality_score: quality }))[0]).toMatchObject({
      quality,
      paused: quality !== 'GREEN',
      reason: quality === 'GREEN' ? null : `ACCOUNT_QUALITY_${quality}`,
    });
  });

  it('retains violations and gives them priority over contradictory GREEN evidence', () => {
    expect(
      parse(payload({}, { event: 'ACCOUNT_VIOLATION', new_quality_score: 'GREEN' }))[0]
    ).toMatchObject({
      quality: 'EVENT_DEGRADED',
      paused: true,
      reason: 'ACCOUNT_ACCOUNT_VIOLATION',
    });
  });

  it('returns the pause reason through the recognized workflow error', async () => {
    const db = {
      pharmacyMarketingSafetyState: {
        findFirst: vi.fn().mockResolvedValue({ reason: 'ACCOUNT_QUALITY_RED' }),
      },
    };
    await expect(
      requireMarketingQuality(db as unknown as ScopedDb, 'org-a')
    ).rejects.toBeInstanceOf(MarketingWorkflowError);
    await expect(requireMarketingQuality(db as unknown as ScopedDb, 'org-a')).rejects.toThrow(
      'auto-paused by provider quality (ACCOUNT_QUALITY_RED)'
    );
    expect(db.pharmacyMarketingSafetyState.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', paused: true },
      select: { reason: true },
    });
  });
});
