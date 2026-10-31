import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { MarketingWorkflowError } from './marketing-service';
import {
  parseMarketingQualityUpdates,
  recordMarketingQualityUpdate,
  requireMarketingQuality,
  resumeMarketingQuality,
} from './marketing-safety';

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

  it.each(['UNBLOCKED', 'UNFLAGGED', 'UNRESTRICTED', 'NOT_A_VIOLATION', 'UNKNOWN'])(
    'does not infer a pause from %s',
    (event) => {
      expect(parse(payload({}, { event }))).toEqual([]);
    }
  );

  it.each(['DISABLED_UPDATE', 'ACCOUNT_BANNED', 'ACCOUNT_BLOCKED', 'ACCOUNT_RESTRICTED'])(
    'pauses on the explicit %s event even with GREEN evidence',
    (event) => {
      expect(parse(payload({}, { event, new_quality_score: 'GREEN' }))[0]).toMatchObject({
        paused: true,
        reason: `ACCOUNT_${event}`,
      });
    }
  );

  it('compares measured block rates and prioritizes a rise over GREEN evidence', () => {
    const rates = { previous_block_rate: 0.01, block_rate: 0.03 };
    const update = parse(payload({}, { ...rates, new_quality_score: 'GREEN' }))[0];
    expect(update).toMatchObject({
      quality: 'BLOCK_RATE_RISE',
      paused: true,
      reason: 'ACCOUNT_BLOCK_RATE_RISE',
      blockRate: { previous: 0.01, current: 0.03 },
    });
    expect(parse(payload({}, rates))[0].paused).toBe(true);
    expect(parse(payload({}, { ...rates, block_rate: 0.01 }))).toEqual([]);
    expect(parse(payload({}, { ...rates, block_rate: 0 }))).toEqual([]);
    expect(parse(payload({}, { block_rate: 0.03 }))).toEqual([]);
    expect(parse(payload({}, { previous_block_rate: 0.01 }))).toEqual([]);
    expect(parse(payload({}, { ...rates, block_rate: 0.04 }))[0].eventKey).not.toBe(
      parse(payload({}, rates))[0].eventKey
    );
  });

  it.each([-1, 2, NaN, Infinity, '0.03'])(
    'ignores invalid block rate measurements: %s',
    (block_rate) => {
      expect(parse(payload({}, { previous_block_rate: 0, block_rate }))).toEqual([]);
    }
  );

  it.each(['FLAGGED', 'DOWNGRADE', 'RED', 'YELLOW', 'GREEN'])(
    'processes a bound phone_number_quality_update: %s',
    (signal) => {
      const change = {
        field: 'phone_number_quality_update',
        value: {
          phone_number_id: 'sender-a',
          ...(['RED', 'YELLOW', 'GREEN'].includes(signal)
            ? { new_quality_score: signal }
            : { event: signal }),
        },
      };
      expect(parse(payload({ changes: [change] }))[0]).toMatchObject({
        paused: signal !== 'GREEN',
      });
      expect(parse(payload({ changes: [{ ...change, value: { event: signal } }] }))).toEqual([]);
    }
  );

  it('binds phone-scoped display numbers explicitly, including contradictory sender evidence', () => {
    const phonePayload = (sender: Record<string, unknown> = {}) =>
      payload({
        changes: [
          {
            field: 'phone_number_quality_update',
            value: { event: 'FLAGGED', display_phone_number: '+923001234567', ...sender },
          },
        ],
      });
    expect(parse(phonePayload())).toEqual([]);
    expect(
      parseMarketingQualityUpdates(phonePayload(), 'sender-a', 'account-a', '+923001234567')[0]
        .paused
    ).toBe(true);
    expect(
      parseMarketingQualityUpdates(phonePayload(), 'sender-a', 'account-a', '+923009999999')
    ).toEqual([]);
    expect(
      parseMarketingQualityUpdates(
        phonePayload({ phone_number_id: 'foreign-sender' }),
        'sender-a',
        'account-a',
        '+923001234567'
      )
    ).toEqual([]);
  });

  it('audits accepted evidence in the supplied transaction and skips stale/replayed evidence', async () => {
    const execute = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const audit = vi.fn();
    const db = { $executeRaw: execute, auditLog: { create: audit } } as unknown as ScopedDb;
    const update = parse(payload())[0];
    await recordMarketingQualityUpdate(db, 'org-a', 'sender-a', update);
    await recordMarketingQualityUpdate(db, 'org-a', 'sender-a', update);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        actorType: 'SYSTEM',
        action: 'pharmacyMarketing.qualityPaused',
        targetId: 'sender-a',
        metadata: expect.objectContaining({ reason: 'ACCOUNT_QUALITY_RED', eventKey: update.eventKey }),
      }),
    });
  });

  it('propagates audit failure to roll back the surrounding tenant transaction', async () => {
    const db = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      auditLog: { create: vi.fn().mockRejectedValue(new Error('audit unavailable')) },
    } as unknown as ScopedDb;
    await expect(
      recordMarketingQualityUpdate(db, 'org-a', 'sender-a', parse(payload())[0])
    ).rejects.toThrow('audit unavailable');
  });

  it('resumes only the state reviewed by the owner and records their reason', async () => {
    const change = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const audit = vi.fn();
    const db = {
      pharmacyMarketingSafetyState: { updateMany: change },
      auditLog: { create: audit },
    } as unknown as ScopedDb;
    const input = {
      senderId: 'sender-a',
      expectedEventKey: 'event-a',
      reason: 'Provider issue resolved.',
    };
    await expect(resumeMarketingQuality(db, 'org-a', 'owner-a', input)).resolves.toEqual({
      paused: false,
    });
    expect(change).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', senderId: 'sender-a', eventKey: 'event-a', paused: true },
      data: { paused: false, reason: 'OWNER_OVERRIDE' },
    });
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        actorType: 'USER',
        actorId: 'owner-a',
        action: 'pharmacyMarketing.qualityOverride',
        metadata: { eventKey: 'event-a', reason: input.reason, paused: false },
      }),
    });
    await expect(resumeMarketingQuality(db, 'org-a', 'owner-a', input)).rejects.toThrow('Reload');
    expect(audit).toHaveBeenCalledTimes(1);
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
