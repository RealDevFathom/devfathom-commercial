import { describe, expect, it, vi } from 'vitest';
import {
  cancelOccurrence,
  guestSecretIsValid,
  hashGuestSecret,
  issueGuestSecret,
  materializeMeetingOccurrences,
  recurrenceRuleFromLegacy,
  rescheduleOccurrence,
} from './occurrences';

describe('meeting occurrence materialization', () => {
  it('adds only the bounded 30-day window and advances the watermark', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 31 });
    const update = vi.fn().mockResolvedValue({});
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      meetingOccurrence: { createMany, findMany },
      meetingParticipant: { findMany: vi.fn().mockResolvedValue([]) },
      meetingOccurrenceParticipant: { createMany: vi.fn() },
      meeting: { update },
    } as never;
    const now = new Date('2026-08-01T09:00:00.000Z');

    await materializeMeetingOccurrences(
      db,
      {
        id: 'meeting-1',
        organizationId: 'org-1',
        startTime: now,
        endTime: new Date('2026-08-01T10:00:00.000Z'),
        recurrenceRule: 'FREQ=DAILY',
        materializedThrough: null,
      },
      now
    );

    const rows = createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(31);
    expect(rows.at(-1).seriesSlotStart).toEqual(new Date('2026-08-31T09:00:00.000Z'));
    expect(update).toHaveBeenCalledWith({
      where: { id: 'meeting-1' },
      data: { materializedThrough: new Date('2026-08-31T09:00:00.000Z') },
    });
  });

  it('hashes guest secrets deterministically without retaining the raw value', () => {
    expect(hashGuestSecret('one-time-secret')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashGuestSecret('one-time-secret')).not.toBe('one-time-secret');
  });

  it('maps the rollout recurrence values to bounded RRULEs', () => {
    expect(recurrenceRuleFromLegacy('biweekly')).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(recurrenceRuleFromLegacy(null)).toBeNull();
  });

  it('reschedules without changing occurrence identity and cancels without deleting', async () => {
    const update = vi.fn().mockResolvedValue({ publicId: 'stable-public-id' });
    const db = { meetingOccurrence: { update } } as never;
    const start = new Date('2026-08-02T09:00:00.000Z');
    const end = new Date('2026-08-02T10:00:00.000Z');

    await rescheduleOccurrence(db, 'occurrence-1', start, end);
    await cancelOccurrence(db, 'occurrence-1', 'user-1', 'Unavailable');

    expect(update.mock.calls[0]![0]).toEqual({
      where: { id: 'occurrence-1' },
      data: { scheduledStart: start, scheduledEnd: end },
    });
    expect(update.mock.calls[1]![0]).toMatchObject({
      where: { id: 'occurrence-1' },
      data: { status: 'CANCELLED', cancelledById: 'user-1', cancellationReason: 'Unavailable' },
    });
    expect(update.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ delete: true }));
  });

  it('emits a guest secret once while persisting only its hash and expiry', async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = { meetingOccurrenceParticipant: { update } } as never;
    const expiresAt = new Date(Date.now() + 60_000);

    const secret = await issueGuestSecret(db, 'grant-1', expiresAt);
    const persisted = update.mock.calls[0]![0].data;

    expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(persisted.guestTokenHash).toBe(hashGuestSecret(secret));
    expect(persisted).not.toHaveProperty('secret');
    expect(persisted.guestTokenExpiresAt).toBe(expiresAt);
  });

  it('rejects expired, revoked, and incorrect guest credentials', () => {
    const guestTokenHash = hashGuestSecret('correct-secret');
    const active = {
      guestTokenHash,
      guestTokenExpiresAt: new Date('2026-09-01'),
      guestTokenRevokedAt: null,
    };
    const now = new Date('2026-08-01');
    expect(guestSecretIsValid(active, 'correct-secret', now)).toBe(true);
    expect(guestSecretIsValid(active, 'wrong-secret', now)).toBe(false);
    expect(guestSecretIsValid({ ...active, guestTokenExpiresAt: now }, 'correct-secret', now)).toBe(
      false
    );
    expect(guestSecretIsValid({ ...active, guestTokenRevokedAt: now }, 'correct-secret', now)).toBe(
      false
    );
  });
});
