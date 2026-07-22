import type { DashboardStats } from '~/types/api';
import type { Meeting } from '~/types/collaboration';
import type { Project } from '~/types/delivery';

export interface DashboardActivityItem {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  userName?: string;
  avatar?: string | null;
}

export interface DashboardDeadline {
  id: string;
  name: string;
  dueDate: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
}

export interface DashboardTask {
  id: string;
  title: string;
  priority: string;
  dueDate?: string | null;
  columnName: string;
  boardId: string;
  projectId: string;
  projectName: string;
}

export interface RevenuePoint {
  month: string;
  income: number;
  expense: number;
  profit: number;
}

export interface RevenueChartData {
  currencies: string[];
  byCurrency: Record<string, RevenuePoint[]>;
}

export interface DashboardTeamPerson {
  id: string;
  name: string;
}

export type DashboardCriticalDataset =
  'stats' | 'activity' | 'projects' | 'meetings' | 'deadlines' | 'tasks';

export interface DashboardBootstrapData {
  stats: DashboardStats | null;
  activity: DashboardActivityItem[];
  projects: Project[];
  meetings: Meeting[];
  deadlines: DashboardDeadline[];
  tasks: DashboardTask[];
  failedDatasets: DashboardCriticalDataset[];
}

export type DashboardCriticalData = DashboardBootstrapData;
