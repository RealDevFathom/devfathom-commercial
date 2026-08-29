import type { MeetingParticipantRole } from '@/generated/prisma/client';

/**
 * What a successful admission hands to the browser — and, by omission, what it
 * does not.
 *
 * This module is deliberately free of `server-only` and of any import that
 * reaches the database or the LiveKit server SDK, because the lobby and call
 * components are client components that need this shape. The logic that
 * PRODUCES it stays in `./admission`, which is server-only.
 *
 * Note what is absent: `providerRoomName`. The room name is generated
 * independently of the public id precisely so a link holder cannot address the
 * media room directly and skip the lobby (MEET-004 D6), so it must never be
 * serialised to a client. It travels only inside the signed grant.
 */
export type MeetingAdmission = {
  /** Short-lived LiveKit join grant. Sized for a join plus a reconnect. */
  token: string;
  serverUrl: string;
  title: string;
  startsAt: string;
  endsAt: string;
  role: MeetingParticipantRole;
};
