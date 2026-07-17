import type { MailMessage, MailProvider, Mailbox } from '~/types/email';

export function useEmail() {
  const { request } = useApi();
  return {
    providers: () => request<Record<MailProvider, boolean>>('/api/email/providers'),
    mailboxes: () => request<Mailbox[]>('/api/email/mailboxes'),
    connect: (provider: MailProvider) =>
      request<{ url: string }>('/api/email/oauth/start', { method: 'POST', body: { provider } }),
    callback: (code: string, state: string) =>
      request<Mailbox>('/api/email/oauth/callback', { method: 'POST', body: { code, state } }),
    disconnect: (id: string) =>
      request<{
        success: boolean;
        revocation: { status?: string; guidance?: string; succeeded: boolean };
      }>(`/api/email/mailboxes/${id}`, { method: 'DELETE' }),
    messages: (mailboxId: string, query = '') =>
      request<MailMessage[]>('/api/email/messages', { query: { mailboxId, query } }),
    message: (mailboxId: string, id: string) =>
      request<MailMessage>(`/api/email/messages/${mailboxId}/${id}`),
    markRead: (mailboxId: string, id: string) =>
      request(`/api/email/messages/${mailboxId}/${id}/read`, { method: 'PATCH' }),
    refresh: (mailboxId: string) =>
      request('/api/email/refresh', { method: 'POST', body: { mailboxId } }),
    send: (body: Record<string, unknown>) => request('/api/email/send', { method: 'POST', body }),
    draft: (body: Record<string, unknown>) =>
      request('/api/email/drafts', { method: 'POST', body }),
  };
}
