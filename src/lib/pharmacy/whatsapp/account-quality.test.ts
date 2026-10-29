import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyAccountQualityUpdates, parseAccountQualityUpdates } from './account-quality';
import { verifyMetaSignature } from './provider';

const fixtureBody = readFileSync(
  'src/lib/pharmacy/whatsapp/__fixtures__/account-update-warning.json',
  'utf8'
);
const fixture = JSON.parse(fixtureBody) as unknown;
const payload = (event: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-fixture', changes: [{ field: 'account_update', value: { event } }] }],
});

describe('WhatsApp account quality', () => {
  it('parses only allowlisted adverse and recovery events', () => {
    expect(parseAccountQualityUpdates(fixture)).toEqual([
      {
        key: 'waba-fixture:ACCOUNT_VIOLATION',
        action: 'hold',
        level: 'warning',
        event: 'ACCOUNT_VIOLATION',
      },
    ]);
    expect(parseAccountQualityUpdates(payload('a new benign event'))).toEqual([]);
    expect(parseAccountQualityUpdates(payload('REINSTATED'))).toEqual([
      {
        key: 'waba-fixture:REINSTATED',
        action: 'recover',
        level: 'recovery',
        event: 'REINSTATED',
      },
    ]);
  });

  it('accepts the fixture only with a valid Meta signature', () => {
    const signature = `sha256=${createHmac('sha256', 'fixture-secret').update(fixtureBody).digest('hex')}`;
    expect(verifyMetaSignature('fixture-secret', fixtureBody, signature)).toBe(true);
    expect(verifyMetaSignature('fixture-secret', fixtureBody, `${signature.slice(0, -1)}0`)).toBe(
      false
    );
  });

  it('idempotently alerts owners, holds feeds, and records system audit evidence', async () => {
    const db = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'owner' }]) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      pharmacyCampaign: {
        updateManyAndReturn: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'approved-campaign' }])
          .mockResolvedValueOnce([{ id: 'captured-campaign' }]),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    };
    await expect(
      applyAccountQualityUpdates(
        db as never,
        'org',
        parseAccountQualityUpdates(fixture),
        'https://business.facebook.com/accountquality'
      )
    ).resolves.toEqual({ alerts: 1, paused: 2, restored: 0 });
    expect(db.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
    expect(db.pharmacyCampaign.updateManyAndReturn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { organizationId: 'org', status: 'APPROVED' },
        data: expect.objectContaining({
          status: 'ACCOUNT_QUALITY_HOLD',
          holdPreviousStatus: 'APPROVED',
        }),
      })
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'SYSTEM',
        input: expect.objectContaining({ providerEvent: 'ACCOUNT_VIOLATION' }),
        result: {
          affectedCampaignIds: ['approved-campaign', 'captured-campaign'],
          campaignCount: 2,
          ownerAlertCount: 1,
        },
      }),
    });
  });

  it('restores only campaigns held by account quality to their prior states', async () => {
    const db = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      notification: { createMany: vi.fn() },
      pharmacyCampaign: {
        updateManyAndReturn: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'approved-campaign' }])
          .mockResolvedValueOnce([{ id: 'captured-campaign' }]),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    };
    await expect(
      applyAccountQualityUpdates(
        db as never,
        'org',
        parseAccountQualityUpdates(payload('REINSTATED')),
        'https://business.facebook.com/accountquality'
      )
    ).resolves.toEqual({ alerts: 0, paused: 0, restored: 2 });
    expect(db.pharmacyCampaign.updateManyAndReturn).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: 'org',
        status: 'ACCOUNT_QUALITY_HOLD',
        holdPreviousStatus: 'APPROVED',
      },
      data: { status: 'APPROVED', holdPreviousStatus: null, refusalReason: null },
      select: { id: true },
    });
  });

  it('makes a retried delivery a durable no-op', async () => {
    const db = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'owner' }]) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      pharmacyCampaign: { updateManyAndReturn: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn() },
    };
    await expect(
      applyAccountQualityUpdates(
        db as never,
        'org',
        parseAccountQualityUpdates(fixture),
        'https://business.facebook.com/accountquality'
      )
    ).resolves.toEqual({ alerts: 0, paused: 0, restored: 0 });
    expect(db.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
