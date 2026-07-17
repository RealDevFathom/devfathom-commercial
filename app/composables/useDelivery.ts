import type {
  Board,
  Checklist,
  ChecklistItem,
  Milestone,
  Project,
  ProjectFile,
  SearchGroups,
  Task,
  TaskComment,
  TimeEntry,
  TimeRollup,
} from '~/types/delivery';

interface DataResponse<T> {
  data: T;
}

export function useDelivery() {
  const { request } = useApi();
  const data = async <T>(path: string, options: Parameters<typeof request<T>>[1] = {}) =>
    (await request<DataResponse<T>>(path, options)).data;

  return {
    listProjects: () => data<Project[]>('/api/v1/projects'),
    getProject: (id: string) => data<Project>(`/api/v1/projects/${id}`),
    createProject: (body: Record<string, unknown>) =>
      data<Project>('/api/v1/projects', { method: 'POST', body }),
    updateProject: (id: string, body: Record<string, unknown>) =>
      data<Project>(`/api/v1/projects/${id}`, { method: 'PATCH', body }),
    removeProject: (id: string) => request(`/api/v1/projects/${id}`, { method: 'DELETE' }),

    getBoard: (id: string) => data<Board>(`/api/v1/boards/${id}`),
    createBoard: (body: Record<string, unknown>) =>
      data<Board>('/api/v1/boards', { method: 'POST', body }),
    updateBoard: (id: string, body: Record<string, unknown>) =>
      data<Board>(`/api/v1/boards/${id}`, { method: 'PATCH', body }),
    createColumn: (body: Record<string, unknown>) =>
      data('/api/v1/columns', { method: 'POST', body }),
    updateColumn: (id: string, body: Record<string, unknown>) =>
      data(`/api/v1/columns/${id}`, { method: 'PATCH', body }),
    removeColumn: (id: string) => request(`/api/v1/columns/${id}`, { method: 'DELETE' }),
    setColumnOwners: (id: string, userIds: string[]) =>
      request(`/api/v1/columns/${id}/default-assignees`, {
        method: 'PUT',
        body: { userIds },
      }),

    getTask: (id: string) => data<Task>(`/api/v1/tasks/${id}`),
    createTask: (body: Record<string, unknown>) =>
      data<Task>('/api/v1/tasks', { method: 'POST', body }),
    updateTask: (id: string, body: Record<string, unknown>) =>
      data<Task>(`/api/v1/tasks/${id}`, { method: 'PATCH', body }),
    removeTask: (id: string) => request(`/api/v1/tasks/${id}`, { method: 'DELETE' }),
    moveTask: (id: string, targetColumnId: string, newOrder: number) =>
      request(`/api/v1/tasks/${id}/move`, {
        method: 'POST',
        body: { targetColumnId, newOrder },
      }),
    setTaskParent: (id: string, parentId: string | null) =>
      request(`/api/v1/tasks/${id}/parent`, { method: 'PUT', body: { parentId } }),
    addBlocker: (id: string, blockingTaskId: string) =>
      data(`/api/v1/tasks/${id}/blockers`, { method: 'POST', body: { blockingTaskId } }),
    removeBlocker: (id: string) => request(`/api/v1/blockers/${id}`, { method: 'DELETE' }),

    listComments: (taskId: string) => data<TaskComment[]>(`/api/v1/tasks/${taskId}/comments`),
    addComment: (taskId: string, content: string, parentId?: string) =>
      data<TaskComment>(`/api/v1/tasks/${taskId}/comments`, {
        method: 'POST',
        body: { content, parentId },
      }),
    updateComment: (id: string, content: string) =>
      data<TaskComment>(`/api/v1/comments/${id}`, { method: 'PATCH', body: { content } }),
    removeComment: (id: string) => request(`/api/v1/comments/${id}`, { method: 'DELETE' }),

    addAttachment: (taskId: string, body: Record<string, unknown>) =>
      data(`/api/v1/tasks/${taskId}/attachments`, { method: 'POST', body }),
    removeAttachment: (id: string) => request(`/api/v1/attachments/${id}`, { method: 'DELETE' }),
    createChecklist: (taskId: string, name: string) =>
      data<Checklist>(`/api/v1/tasks/${taskId}/checklists`, {
        method: 'POST',
        body: { name },
      }),
    updateChecklist: (id: string, name: string) =>
      data<Checklist>(`/api/v1/checklists/${id}`, { method: 'PATCH', body: { name } }),
    removeChecklist: (id: string) => request(`/api/v1/checklists/${id}`, { method: 'DELETE' }),
    createChecklistItem: (id: string, text: string) =>
      data<ChecklistItem>(`/api/v1/checklists/${id}/items`, {
        method: 'POST',
        body: { text },
      }),
    updateChecklistItem: (id: string, body: Record<string, unknown>) =>
      data<ChecklistItem>(`/api/v1/checklist-items/${id}`, { method: 'PATCH', body }),
    removeChecklistItem: (id: string) =>
      request(`/api/v1/checklist-items/${id}`, { method: 'DELETE' }),

    listMilestones: (projectId: string) =>
      data<Milestone[]>(`/api/v1/projects/${projectId}/milestones`),
    createMilestone: (projectId: string, body: Record<string, unknown>) =>
      data<Milestone>(`/api/v1/projects/${projectId}/milestones`, { method: 'POST', body }),
    updateMilestone: (id: string, body: Record<string, unknown>) =>
      data<Milestone>(`/api/v1/milestones/${id}`, { method: 'PATCH', body }),
    removeMilestone: (id: string) => request(`/api/v1/milestones/${id}`, { method: 'DELETE' }),

    listFiles: (projectId: string) => data<ProjectFile[]>(`/api/v1/projects/${projectId}/files`),
    addFile: (projectId: string, body: Record<string, unknown>) =>
      data<ProjectFile>(`/api/v1/projects/${projectId}/files`, { method: 'POST', body }),
    removeFile: (id: string) => request(`/api/v1/project-files/${id}`, { method: 'DELETE' }),

    listTaskTime: (taskId: string) => data<TimeEntry[]>(`/api/v1/tasks/${taskId}/time-entries`),
    getTimeRollup: (projectId: string) =>
      data<TimeRollup>(`/api/v1/projects/${projectId}/time-rollup`),
    addTime: (body: Record<string, unknown>) =>
      data<TimeEntry>('/api/v1/time-entries', { method: 'POST', body }),
    removeTime: (id: string) => request(`/api/v1/time-entries/${id}`, { method: 'DELETE' }),

    importTrello: (body: Record<string, unknown>) =>
      data<Record<string, unknown>>('/api/v1/trello-import', { method: 'POST', body }),
    search: (query: string) => data<SearchGroups>('/api/v1/search', { query: { query } }),
  };
}
