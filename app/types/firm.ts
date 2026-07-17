export interface DataResponse<T> {
  data: T;
}
export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'HR' | 'EMPLOYEE';
  department: string;
  title: string;
  avatar?: string | null;
  phone?: string | null;
  bio?: string | null;
  skills: string[];
  startDate?: string;
  status: string;
  lastActiveAt?: string | null;
  projectCount?: number;
  taskCount?: number;
}

export interface TeamMemberStats {
  userId: string;
  name: string;
  avatar?: string | null;
  title?: string | null;
  openTasks: number;
  completedThisWeek: number;
  completedLastWeek: number;
  overdueTasks: number;
  avgCycleTimeDays?: number | null;
  meetingsInvited: number;
  meetingsAttended: number;
  avgMinutesLate?: number | null;
  onTimePercent?: number | null;
  notesAuthored: number;
  projectsActive: number;
  commentsThisWeek: number;
  lastActiveAt?: string | null;
  tasksDoneSparkline: number[];
}

export interface TeamStatsOverview {
  members: TeamMemberStats[];
  alerts: Array<{
    userId: string;
    name: string;
    severity: 'high' | 'medium' | 'low';
    kind: string;
    message: string;
  }>;
  velocity: Array<{ date: string; count: number }>;
  leaderboards: {
    topCompleter: TeamMemberStats[];
    bestPunctuality: TeamMemberStats[];
    fastestCycle: TeamMemberStats[];
    mostCollaborative: TeamMemberStats[];
  };
  totals: {
    teamCompletedThisWeek: number;
    teamCompletedLastWeek: number;
    teamOpenTasks: number;
    teamOverdue: number;
    teamMembers: number;
    membersWithNoTasks: number;
  };
}
export interface Transaction {
  id: string;
  type: 'INCOME' | 'EXPENSE';
  amount: number;
  currency: 'USD' | 'PKR';
  category?: string | null;
  description: string;
  projectId?: string | null;
  clientId?: string | null;
  projectName?: string | null;
  clientName?: string | null;
  date: string;
}
export interface RecurringExpense {
  id: string;
  name: string;
  amount: number;
  currency: 'USD' | 'PKR';
  category: string;
  interval: 'monthly' | 'quarterly' | 'yearly';
  nextDueDate: string;
  vendorName?: string | null;
  active: boolean;
}
export interface InvoiceItem {
  description: string;
  quantity: number;
  rate: number;
  amount?: number;
}
export interface Payment {
  id: string;
  invoiceId: string;
  amount: number;
  currency: 'USD' | 'PKR';
  method?: string | null;
  note?: string | null;
  paidAt: string;
}
export interface Invoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  clientLogo?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  items: InvoiceItem[];
  subtotal: number;
  tax: number;
  total: number;
  currency: 'USD' | 'PKR';
  status: 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED';
  dueDate: string;
  notes?: string | null;
  amountPaid: number;
  balance: number;
  payments?: Payment[];
  createdAt: string;
}
export interface CurrencySummary {
  currency: 'USD' | 'PKR';
  monthly_income: number;
  monthly_expense: number;
  monthly_profit: number;
  yearly_income: number;
  yearly_expense: number;
  yearly_profit: number;
  total_paid: number;
  paid_count: number;
  total_outstanding: number;
  outstanding_count: number;
}
export interface LeaveRequest {
  id: string;
  userId: string;
  userName?: string;
  type: 'VACATION' | 'SICK' | 'REMOTE';
  startDate: string;
  endDate: string;
  reason?: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
}
export interface LeaveBalance {
  type: 'VACATION' | 'SICK' | 'REMOTE';
  entitledDays: number;
  usedDays: number;
  remaining: number;
}
export interface Resignation {
  id: string;
  userId: string;
  userName?: string;
  reason: string;
  proposedLastDay: string;
  lastWorkingDay?: string | null;
  status: string;
  reviewNote?: string | null;
  createdAt: string;
}
export interface Review {
  id: string;
  cycleId: string;
  cycleName: string;
  cycleStatus: string;
  subjectId: string;
  subjectName: string;
  reviewerId: string;
  reviewerName: string;
  status: string;
  rating?: number | null;
  strengths?: string | null;
  improvements?: string | null;
  comments?: string | null;
  createdAt: string;
}
export interface ReviewCycle {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  reviewCount: number;
  createdByName: string;
}
export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  boundUser?: { id: string; name: string };
}
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  deliveryCount: number;
  deliveries: {
    id: string;
    event: string;
    statusCode?: number;
    success: boolean;
    error?: string;
    attemptedAt: string;
  }[];
  createdAt: string;
}
export interface AuditLog {
  id: string;
  actorName?: string | null;
  actorType: string;
  category: string;
  operation: string;
  source: string;
  outcome: string;
  action: string;
  description?: string | null;
  targetLabel?: string | null;
  createdAt: string;
  ip?: string | null;
}
