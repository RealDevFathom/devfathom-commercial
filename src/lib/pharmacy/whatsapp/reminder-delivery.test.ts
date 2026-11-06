import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { recordReminderDelivery } from './reminder-delivery';

const NOW = new Date('2026-10-21T08:00:00.000Z');
const event = {
  messageId: 'wamid-reminder',
  state: 'FAILED' as const,
  occurredAt: new Date('2026-10-21T07:59:00.000Z'),
  errorCodes: [131026],
};
function database() {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  return { updateMany, db: { pharmacyMessageLog: { updateMany } } as unknown as ScopedDb };
}

describe('permanent reminder delivery evidence', () => {
  it('marks only tenant-scoped outbound WhatsApp utility reminders as permanently failed', async () => {
    const { db, updateMany } = database();
    await recordReminderDelivery(db, 'org_a', event, NOW);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org_a',
        channel: 'WHATSAPP',
        direction: 'OUTBOUND',
        kind: { in: ['REFILL_REMINDER', 'KHATA_REMINDER'] },
        providerMessageId: event.messageId,
        status: { in: ['SENT', 'PENDING'] },
        createdAt: { lt: new Date(event.occurredAt.getTime() + 1000) },
        OR: [{ error: null }, { error: { not: 'DELIVERY_CONFIRMED' } }],
      },
      data: { status: 'FAILED', error: 'WHATSAPP_DELIVERY_FAILED' },
    });
  });

  it.each([
    { errorCodes: [] },
    { errorCodes: [131000] },
    { errorCodes: [130429] },
    { errorCodes: [999999] },
  ])('ignores unknown/transient/missing failure codes: %j', async ({ errorCodes }) => {
    const { db, updateMany } = database();
    await recordReminderDelivery(db, 'org_a', { ...event, errorCodes }, NOW);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ignores acceptance and future evidence', async () => {
    const { db, updateMany } = database();
    await recordReminderDelivery(db, 'org_a', { ...event, state: 'PROVIDER_ACCEPTED' }, NOW);
    await recordReminderDelivery(
      db,
      'org_a',
      { ...event, occurredAt: new Date(NOW.getTime() + 1000) },
      NOW
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('records delivery confirmation so a replayed failure cannot enable fallback', async () => {
    const { db, updateMany } = database();
    await recordReminderDelivery(
      db,
      'org_a',
      { ...event, state: 'DELIVERED', errorCodes: [] },
      NOW
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'SENT', error: 'DELIVERY_CONFIRMED' },
      })
    );
  });
});
