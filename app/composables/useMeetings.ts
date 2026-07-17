import type { Meeting } from '~/types/collaboration';

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
        attendees: { user: { id: string; name: string }; attended: number; rate: number }[];
      }>(`/api/v1/meetings/${id}/attendance`),
  };
}
