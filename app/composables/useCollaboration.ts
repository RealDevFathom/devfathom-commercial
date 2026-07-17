import type {
  CollaborationSearch,
  NotificationItem,
  NotificationPreferences,
  Person,
} from '~/types/collaboration';

export function useCollaboration() {
  const { request } = useApi();
  return {
    search: (query: string) =>
      request<CollaborationSearch>('/api/v1/search/collaboration', { query: { query } }),
    people: async (query: string) => {
      const results = await request<CollaborationSearch>('/api/v1/search/collaboration', {
        query: { query },
      });
      return results.team as Person[];
    },
    notifications: (unreadOnly = false) =>
      request<NotificationItem[]>('/api/v1/notifications', { query: { unreadOnly } }),
    markRead: (id: string) => request(`/api/v1/notifications/${id}/read`, { method: 'PATCH' }),
    markAllRead: () => request('/api/v1/notifications/read-all', { method: 'POST' }),
    preferences: () => request<NotificationPreferences | null>('/api/v1/notifications/preferences'),
    savePreferences: (body: NotificationPreferences) =>
      request('/api/v1/notifications/preferences', { method: 'PUT', body }),
  };
}
