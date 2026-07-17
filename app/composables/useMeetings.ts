import type { Meeting } from '~/types/collaboration';

export type MeetingPhase = 'upcoming' | 'live' | 'ended';

export interface MeetingCountdown {
  phase: MeetingPhase;
  hours: string;
  minutes: string;
  seconds: string;
  totalMilliseconds: number;
}

export function getMeetingPhase(meeting: Pick<Meeting, 'startTime' | 'endTime'>, now: number) {
  const start = new Date(meeting.startTime).getTime();
  const end = new Date(meeting.endTime).getTime();
  if (now < start) return 'upcoming' as const;
  if (now < end) return 'live' as const;
  return 'ended' as const;
}

export function getMeetingCountdown(
  meeting: Pick<Meeting, 'startTime' | 'endTime'>,
  now: number
): MeetingCountdown {
  const phase = getMeetingPhase(meeting, now);
  const start = new Date(meeting.startTime).getTime();
  const totalMilliseconds =
    phase === 'upcoming' ? Math.max(0, start - now) : Math.max(0, now - start);
  return {
    phase,
    hours: String(Math.floor(totalMilliseconds / 3_600_000)).padStart(2, '0'),
    minutes: String(Math.floor((totalMilliseconds % 3_600_000) / 60_000)).padStart(2, '0'),
    seconds: String(Math.floor((totalMilliseconds % 60_000) / 1000)).padStart(2, '0'),
    totalMilliseconds,
  };
}

export function useMeetings() {
  const { request } = useApi();
  return {
    list: () => request<Meeting[]>('/api/v1/meetings'),
    upcoming: () => request<Meeting[]>('/api/v1/meetings/upcoming'),
    get: (id: string) => request<Meeting>(`/api/v1/meetings/${id}`),
    create: (body: Record<string, unknown>) =>
      request<Meeting>('/api/v1/meetings', { method: 'POST', body }),
    update: (id: string, body: Record<string, unknown>) =>
      request<Meeting>(`/api/v1/meetings/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request(`/api/v1/meetings/${id}`, { method: 'DELETE' }),
    join: (id: string) => request(`/api/v1/meetings/${id}/join`, { method: 'POST' }),
    callToken: (id: string) =>
      request<{ jwt: string; roomName: string }>(`/api/v1/meetings/${id}/call-token`, {
        method: 'POST',
      }),
    callJoin: (id: string) => request(`/api/v1/meetings/${id}/call/join`, { method: 'POST' }),
    callLeave: (id: string) => request(`/api/v1/meetings/${id}/call/leave`, { method: 'POST' }),
    attendance: (id: string) =>
      request<{
        heldOccurrences: number;
        attendees: {
          user: { id: string; name: string; avatar?: string | null };
          attended: number;
          rate: number;
          lastJoinedAt?: string | null;
        }[];
      }>(`/api/v1/meetings/${id}/attendance`),
  };
}
