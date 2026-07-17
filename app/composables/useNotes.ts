import type { Note, NoteRevision, NoteSummary, TiptapNode } from '~/types/collaboration';

export function useNotes() {
  const { request } = useApi();
  return {
    list: (query: Record<string, unknown> = {}) =>
      request<NoteSummary[]>('/api/v1/notes', { query }),
    mentions: () => request<NoteSummary[]>('/api/v1/notes/mentions'),
    searchTitles: (query: string) =>
      request<{ id: string; title: string }[]>('/api/v1/notes/search', { query: { query } }),
    get: (id: string) => request<Note>(`/api/v1/notes/${id}`),
    create: (body: {
      title: string;
      contentJson: TiptapNode;
      visibility: NoteSummary['visibility'];
    }) => request<Note>('/api/v1/notes', { method: 'POST', body }),
    update: (id: string, body: Record<string, unknown>) =>
      request<Note>(`/api/v1/notes/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request(`/api/v1/notes/${id}`, { method: 'DELETE' }),
    setShares: (id: string, shares: { userId: string; permission: 'VIEW' | 'EDIT' }[]) =>
      request(`/api/v1/notes/${id}/shares`, { method: 'PUT', body: { shares } }),
    revisions: (id: string) => request<NoteRevision[]>(`/api/v1/notes/${id}/revisions`),
    revision: (id: string) => request<NoteRevision>(`/api/v1/notes/revisions/${id}`),
    restore: (id: string) => request(`/api/v1/notes/revisions/${id}/restore`, { method: 'POST' }),
  };
}
