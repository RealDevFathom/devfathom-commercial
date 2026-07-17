export interface User {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'HR' | 'EMPLOYEE';
  title?: string;
  department?: string;
  avatar?: string | null;
}

export interface ApiResponse<T> {
  data: T;
}

export interface DashboardStats {
  activeProjects: number;
  totalTasks: number;
  completedTasksThisWeek: number;
  pendingLeaves: number;
  outstandingInvoices: number;
  revenue: Array<{ currency: string; amount: number }>;
  expenses: Array<{ currency: string; amount: number }>;
  isAdmin: boolean;
}
