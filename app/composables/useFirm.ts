import type {
  ApiTokenRecord,
  AuditLog,
  CurrencySummary,
  DataResponse,
  Invoice,
  LeaveBalance,
  LeaveRequest,
  Payment,
  RecurringExpense,
  Resignation,
  Review,
  ReviewCycle,
  TeamMember,
  TeamStatsOverview,
  Transaction,
  Webhook,
} from '~/types/firm';
export function useFirm() {
  const { request } = useApi();
  const data = async <T>(path: string, options: Parameters<typeof request<T>>[1] = {}) =>
    (await request<DataResponse<T>>(path, options)).data;
  return {
    summary: () => request<{ byCurrency: CurrencySummary[] }>('/api/finance/summary'),
    transactions: () => data<Transaction[]>('/api/finance/transactions'),
    createTransaction: (body: Record<string, unknown>) =>
      data<Transaction>('/api/finance/transactions', { method: 'POST', body }),
    updateTransaction: (id: string, body: Record<string, unknown>) =>
      data<Transaction>(`/api/finance/transactions/${id}`, { method: 'PATCH', body }),
    removeTransaction: (id: string) =>
      request(`/api/finance/transactions/${id}`, { method: 'DELETE' }),
    recurringExpenses: () => data<RecurringExpense[]>('/api/finance/recurring-expenses'),
    createRecurringExpense: (body: Record<string, unknown>) =>
      data<RecurringExpense>('/api/finance/recurring-expenses', { method: 'POST', body }),
    removeRecurringExpense: (id: string) =>
      request(`/api/finance/recurring-expenses/${id}`, { method: 'DELETE' }),
    postDueRecurringExpenses: () =>
      request<{ posted: number }>('/api/finance/recurring-expenses/post-due', { method: 'POST' }),
    invoices: () => data<Invoice[]>('/api/finance/invoices'),
    invoice: (id: string) => data<Invoice>(`/api/finance/invoices/${id}`),
    createInvoice: (body: Record<string, unknown>) =>
      data<Invoice>('/api/finance/invoices', { method: 'POST', body }),
    updateInvoiceStatus: (id: string, status: string) =>
      data<Invoice>(`/api/finance/invoices/${id}/status`, { method: 'PATCH', body: { status } }),
    addPayment: (id: string, body: Record<string, unknown>) =>
      request<{ data: Payment; amountPaid: number; balance: number; status: string }>(
        `/api/finance/invoices/${id}/payments`,
        { method: 'POST', body }
      ),
    removePayment: (id: string) => request(`/api/finance/payments/${id}`, { method: 'DELETE' }),
    team: () => data<TeamMember[]>('/api/team'),
    teamStats: () => data<TeamStatsOverview>('/api/team/stats/overview'),
    member: (id: string) => data<TeamMember>(`/api/team/${id}`),
    updateMe: (body: Record<string, unknown>) =>
      data<TeamMember>('/api/team/me', { method: 'PATCH', body }),
    updateMember: (id: string, body: Record<string, unknown>) =>
      data<TeamMember>(`/api/team/${id}/admin`, { method: 'PATCH', body }),
    performanceNotes: (id: string) =>
      data<Array<Record<string, unknown>>>(`/api/hr/performance-notes/${id}`),
    addPerformanceNote: (user_id: string, content: string) =>
      data<Record<string, unknown>>('/api/hr/performance-notes', {
        method: 'POST',
        body: { user_id, content },
      }),
    adminResetPassword: (id: string, new_password: string) =>
      request(`/api/auth/members/${id}/reset-password`, { method: 'POST', body: { new_password } }),
    layoff: (id: string, reason: string) =>
      request(`/api/auth/members/${id}/layoff`, { method: 'POST', body: { reason } }),
    invite: (body: Record<string, unknown>) =>
      request<{ id: string; inviteToken: string; inviteUrl: string }>('/api/auth/invitations', {
        method: 'POST',
        body,
      }),
    leave: (mine = false) => data<LeaveRequest[]>(mine ? '/api/hr/leave/mine' : '/api/hr/leave'),
    requestLeave: (body: Record<string, unknown>) =>
      data<LeaveRequest>('/api/hr/leave', { method: 'POST', body }),
    decideLeave: (id: string, status: string) =>
      data<LeaveRequest>(`/api/hr/leave/${id}/decision`, { method: 'PATCH', body: { status } }),
    balances: (userId?: string) =>
      request<{ userId: string; year: number; types: LeaveBalance[] }>('/api/hr/leave-balances', {
        query: { user_id: userId },
      }),
    setBalance: (body: Record<string, unknown>) =>
      request('/api/hr/leave-balances', { method: 'PUT', body }),
    resignations: (mine = false) =>
      data<Resignation[]>(mine ? '/api/hr/resignations/mine' : '/api/hr/resignations'),
    resign: (body: Record<string, unknown>) =>
      data<Resignation>('/api/hr/resignations', { method: 'POST', body }),
    withdrawResignation: (id: string) =>
      data<Resignation>(`/api/hr/resignations/${id}/withdraw`, { method: 'PATCH' }),
    decideResignation: (id: string, body: Record<string, unknown>) =>
      data<Resignation>(`/api/hr/resignations/${id}/decision`, { method: 'PATCH', body }),
    reviews: () => data<Review[]>('/api/hr/reviews'),
    cycles: () => data<ReviewCycle[]>('/api/hr/review-cycles'),
    createCycle: (body: Record<string, unknown>) =>
      data<ReviewCycle>('/api/hr/review-cycles', { method: 'POST', body }),
    assignReview: (cycleId: string, subject_id: string, reviewer_id: string) =>
      data<Review>(`/api/hr/review-cycles/${cycleId}/reviews`, {
        method: 'POST',
        body: { subject_id, reviewer_id },
      }),
    changeCycle: (id: string, action: 'close' | 'reopen') =>
      data<ReviewCycle>(`/api/hr/review-cycles/${id}/${action}`, { method: 'PATCH' }),
    submitReview: (id: string, body: Record<string, unknown>) =>
      data<Review>(`/api/hr/reviews/${id}/submit`, { method: 'PATCH', body }),
    hrStats: () => data<Record<string, number>>('/api/hr/stats'),
    preferences: () =>
      request<{
        preferences: Record<string, unknown>;
        notificationPreferences: Record<string, Record<string, boolean>> | null;
      }>('/api/auth/preferences'),
    savePreferences: (body: Record<string, unknown>) =>
      request('/api/auth/preferences', { method: 'PUT', body }),
    changePassword: (currentPassword: string, newPassword: string) =>
      request('/api/auth/password', {
        method: 'PATCH',
        body: { current_password: currentPassword, new_password: newPassword },
      }),
    sessions: () =>
      request<{ data: Record<string, unknown>[]; revocation: string }>('/api/auth/sessions'),
    signOutEverywhere: () => request('/api/auth/sign-out-everywhere', { method: 'POST' }),
    twoFactorStatus: () => request<Record<string, unknown>>('/api/auth/two-factor/status'),
    twoFactorEnroll: () =>
      request<{ secret: string; otpauthUri: string }>('/api/auth/two-factor/enrollment', {
        method: 'POST',
      }),
    twoFactorConfirm: (token: string) =>
      request<{ recoveryCodes: string[] }>('/api/auth/two-factor/enrollment/confirm', {
        method: 'POST',
        body: { token },
      }),
    twoFactorDisable: (token: string) =>
      request('/api/auth/two-factor', { method: 'DELETE', body: { token } }),
    apiTokens: () => data<ApiTokenRecord[]>('/api/admin/api-tokens'),
    tokenScopes: () => data<string[]>('/api/admin/api-tokens/scopes'),
    createToken: (body: Record<string, unknown>) =>
      request<ApiTokenRecord & { token: string }>('/api/admin/api-tokens', {
        method: 'POST',
        body,
      }),
    revokeToken: (id: string) => request(`/api/admin/api-tokens/${id}`, { method: 'DELETE' }),
    webhooks: () => data<Webhook[]>('/api/admin/webhooks'),
    createWebhook: (body: Record<string, unknown>) =>
      data<Webhook & { secret: string }>('/api/admin/webhooks', { method: 'POST', body }),
    removeWebhook: (id: string) => request(`/api/admin/webhooks/${id}`, { method: 'DELETE' }),
    auditLogs: (query: Record<string, unknown>) =>
      request<{ items: AuditLog[]; nextCursor?: string | null }>('/api/admin/audit-logs', {
        query,
      }),
    auditStats: () => request<Record<string, unknown>>('/api/admin/audit-logs/stats'),
    auditFilters: () => request<Record<string, unknown>>('/api/admin/audit-logs/filters'),
  };
}
