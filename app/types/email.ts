export type MailProvider = 'GMAIL' | 'OUTLOOK';

export interface Mailbox {
  id: string;
  type: MailProvider;
  emailAddress: string;
  displayName?: string | null;
  status: string;
  lastSyncedAt?: string | null;
  createdAt: string;
}

export interface MailMessage {
  id: string;
  mailboxId: string;
  threadId?: string | null;
  fromAddr: string;
  toAddrs: string[];
  subject?: string | null;
  snippet?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  isRead: boolean;
  hasAttachments: boolean;
  sentAt?: string | number | null;
  mailbox: Pick<Mailbox, 'type' | 'emailAddress'>;
}
