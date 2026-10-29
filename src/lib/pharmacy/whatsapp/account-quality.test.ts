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

describe('WhatsApp account quality', () => {
  it('parses the account_update fixture without retaining provider detail', () => {
    expect(parseAccountQualityUpdates(fixture)).toEqual([
      { key: 'waba-fixture:ACCOUNT_VIOLATION', level: 'warning', event: 'ACCOUNT_VIOLATION' },
    ]);
  });

  it('accepts the fixture only with a valid Meta signature', () => {
    const signature = `sha256=${createHmac('sha256', 'fixture-secret').update(fixtureBody).digest('hex')}`;
    expect(verifyMetaSignature('fixture-secret', fixtureBody, signature)).toBe(true);
    expect(verifyMetaSignature('fixture-secret', fixtureBody, `${signature.slice(0, -1)}0`)).toBe(
      false
    );
  });

  it('alerts every owner with an appeal link and pauses runnable feeds', async () => {
    const db = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'owner' }]) },
      notification: {
        findFirst: vi.fn().mockResolvedValue(null),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      pharmacyCampaign: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const updates = parseAccountQualityUpdates(fixture);
    await expect(
      applyAccountQualityUpdates(db as never, 'org', updates, 'https://appeal.example/account')
    ).resolves.toEqual({ alerts: 1, paused: 2 });
    expect(db.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'owner',
          message: expect.stringContaining('https://appeal.example/account'),
        }),
      ],
    });
    expect(db.pharmacyCampaign.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', status: { in: ['APPROVED', 'CAPTURED'] } },
      data: { status: 'REFUSED', refusalReason: 'WhatsApp account-quality hold' },
    });
  });
});
