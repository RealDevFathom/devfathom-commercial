export type ProjectStatus = 'ACTIVE' | 'IN_DEVELOPMENT' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface PersonRef {
  id: string;
  name: string;
  avatar?: string | null;
  title?: string | null;
  email?: string;
}

export interface ProjectMember {
  id: string;
  role: 'LEAD' | 'MEMBER';
  user: PersonRef;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  boardId: string;
}

export interface TaskComment {
  id: string;
  content: string;
  taskId: string;
  userId: string;
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
  user?: PersonRef;
  replies?: TaskComment[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
  checklistId: string;
  order: number;
}

export interface Checklist {
  id: string;
  name: string;
  taskId: string;
  order: number;
  items: ChecklistItem[];
}

export interface TaskAttachment {
  id: string;
  name: string;
  url: string;
  type?: string | null;
  size?: number | null;
  taskId: string;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  columnId: string;
  order: number;
  priority: Priority;
  dueDate?: string | null;
  createdById: string;
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
  assignees: Array<{ id: string; user: PersonRef }>;
  labels: Array<{ id: string; label: Label }>;
  comments?: TaskComment[];
  checklists?: Checklist[];
  attachments?: TaskAttachment[];
  subtasks?: Array<{ id: string; title: string; column: { id: string; name: string } }>;
  blockedBy?: Array<{
    id: string;
    blockingTask: { id: string; title: string; column: { name: string } };
  }>;
  blocking?: Array<{
    id: string;
    blockedTask: { id: string; title: string; column: { name: string } };
  }>;
  column?: { id: string; name: string; board: { id: string; name: string; projectId: string } };
  _count?: { comments: number; attachments: number; checklists: number };
  activity?: Array<Record<string, unknown>>;
}

export interface BoardColumn {
  id: string;
  name: string;
  boardId: string;
  order: number;
  wipLimit?: number | null;
  tasks: Task[];
  defaultAssignees: Array<{ id: string; user: PersonRef }>;
  _count?: { tasks: number };
}

export interface Board {
  id: string;
  name: string;
  description?: string | null;
  projectId: string;
  project?: { id: string; name: string; members?: ProjectMember[] };
  labels: Label[];
  columns: BoardColumn[];
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  name: string;
  description?: string | null;
  projectId: string;
  dueDate: string;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile {
  id: string;
  name: string;
  url: string;
  type?: string | null;
  size?: number | null;
  projectId: string;
  uploadedById: string;
  createdAt: string;
  uploadedBy?: PersonRef;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  status: ProjectStatus;
  type: 'CLIENT' | 'INTERNAL';
  startDate?: string | null;
  endDate?: string | null;
  techStack: string[];
  budget?: number | null;
  clientId?: string | null;
  client?: { id?: string; name: string; logo?: string | null; website?: string | null } | null;
  members: ProjectMember[];
  boards?: Board[];
  milestones?: Milestone[];
  files?: ProjectFile[];
  _count?: { boards: number; milestones: number; files: number };
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntry {
  id: string;
  userId: string;
  taskId?: string | null;
  projectId: string;
  description?: string | null;
  hours: number;
  date: string;
  user?: PersonRef;
}

export interface TimeRollup {
  projectId: string;
  totalHours: number;
  entryCount: number;
  byUser: Array<{
    userId: string;
    name: string;
    avatar?: string | null;
    hours: number;
    entries: number;
  }>;
  byTask: Array<{ taskId?: string | null; title: string; hours: number; entries: number }>;
}

export interface SearchGroups {
  projects: Project[];
  tasks: Task[];
  clients: Array<{ id: string; name: string; industry?: string | null }>;
  notes: Array<{ id: string; title: string; visibility: string; author: PersonRef }>;
  team: PersonRef[];
}
