import type {
  CollaborationSearch,
  NotificationItem,
  NotificationPreferences,
} from '~/types/collaboration';

export function useCollaboration() {
  const { request } = useApi();
  return {
    search: (query: string) =>
      request<CollaborationSearch>('/api/v1/search/collaboration', { query: { query } }),
    notifications: (unreadOnly = false) =>
      request<NotificationItem[]>('/api/v1/notifications', { query: { unreadOnly } }),
    markRead: (id: string) => request(`/api/v1/notifications/${id}/read`, { method: 'PATCH' }),
    markAllRead: () => request('/api/v1/notifications/read-all', { method: 'POST' }),
    preferences: () => request<NotificationPreferences | null>('/api/v1/notifications/preferences'),
    savePreferences: (body: NotificationPreferences) =>
      request('/api/v1/notifications/preferences', { method: 'PUT', body }),
  };
}
