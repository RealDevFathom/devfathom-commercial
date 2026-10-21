import 'server-only';

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { recordAndApplyProviderEvent } from './events';
import type { MeetingProviderAdapter, NormalizedMeetingEvent } from './types';

export type ReconciliationResult = { inspected: number; repaired: number };

export async function reconcileMeetingOccurrences(
  provider: Pick<MeetingProviderAdapter, 'getRoomState'>,
  options: { now?: Date; horizonMs?: number } = {}
): Promise<ReconciliationResult> {
  const now = options.now ?? new Date();
  const horizonMs = options.horizonMs ?? 6 * 60 * 60 * 1000;
  const occurrences = await withPlatformDb((db) =>
    db.meetingOccurrence.findMany({
      where: {
        status: { in: ['ACTIVE', 'OPEN', 'SCHEDULED'] },
        scheduledStart: { lte: now },
        scheduledEnd: { gte: new Date(now.getTime() - horizonMs) },
      },
      select: { id: true, organizationId: true, providerRoomName: true, status: true },
    })
  );

  let repaired = 0;
  for (const occurrence of occurrences) {
    const state = await provider.getRoomState(occurrence.providerRoomName);
    const sessions = await withTenantDb(occurrence.organizationId, (db) =>
      db.meetingParticipantSession.findMany({
        where: { occurrenceId: occurrence.id, source: 'WEBHOOK' },
        select: { providerParticipantSid: true, leftAt: true },
      })
    );
    const known = new Map(sessions.map((session) => [session.providerParticipantSid, session]));
    const synthetic: NormalizedMeetingEvent[] = [];

    if (state.active && occurrence.status !== 'ACTIVE') {
      synthetic.push({
        id: `reconcile:start:${occurrence.id}:${(state.startedAt ?? now).toISOString()}`,
        type: 'room.started',
        providerType: 'reconcile.room_started',
        roomName: occurrence.providerRoomName,
        occurredAt: state.startedAt ?? now,
        payload: { source: 'reconciliation' },
      });
    }

    for (const participant of state.participants) {
      if (!known.has(participant.id)) {
        synthetic.push({
          id: `reconcile:join:${occurrence.id}:${participant.id}:${participant.joinedAt.toISOString()}`,
          type: 'participant.joined',
          providerType: 'reconcile.participant_joined',
          roomName: occurrence.providerRoomName,
          participantId: participant.id,
          participantIdentity: participant.identity,
          occurredAt: participant.joinedAt,
          payload: { source: 'reconciliation' },
        });
      }
    }
    if (!state.active) {
      synthetic.push({
        id: `reconcile:finish:${occurrence.id}:${(state.endedAt ?? now).toISOString()}`,
        type: 'room.finished',
        providerType: 'reconcile.room_finished',
        roomName: occurrence.providerRoomName,
        occurredAt: state.endedAt ?? now,
        payload: { source: 'reconciliation' },
      });
    }

    for (const event of synthetic) {
      if ((await recordAndApplyProviderEvent(occurrence, event)) === 'processed') repaired += 1;
    }
    if (synthetic.length > 0) {
      console.warn('meeting_reconciliation_repaired', {
        occurrenceId: occurrence.id,
        organizationId: occurrence.organizationId,
        repairs: synthetic.length,
      });
    }
  }
  return { inspected: occurrences.length, repaired };
}
