import { decryptToken } from './crypto';
import { GmailAdapter } from './providers/gmail';
import { OutlookAdapter } from './providers/outlook';
import { HostedAdapter } from './providers/hosted';

/**
 * The Mailbox abstraction. Every provider (Gmail, Outlook, and a future HOSTED
 * @domain mailbox) implements the SAME {@link MailAdapter} interface, and the
 * router/UI only ever talk to this interface — never to a specific provider. To
 * add a provider later you implement the interface and register it in
 * {@link createAdapter}; nothing in email.ts or the UI changes.
 */

export type ProviderType = 'GMAIL' | 'OUTLOOK' | 'HOSTED';

/** Provider-agnostic message shape. Bodies are null until backfilled on open. */
export interface NormalizedMessage {
  providerMessageId: string;
  threadId: string | null;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs: string[];
  subject: string | null;
  snippet: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: boolean;
  hasAttachments: boolean;
  sentAt: Date;
}

export interface ListOptions {
  /** Max messages to return (provider page size). */
  limit?: number;
  /** Opaque provider cursor for backfill/pagination. */
  pageToken?: string | null;
}

export interface ListResult {
  messages: NormalizedMessage[];
  nextPageToken: string | null;
}

export interface SendOptions {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
}

export interface MailAdapter {
  /** Most recent inbox messages (metadata + snippet), newest first. */
  listMessages(opts?: ListOptions): Promise<ListResult>;
  /** Full single message including the HTML/text body. */
  getMessage(providerMessageId: string): Promise<NormalizedMessage | null>;
  /** Send a message from this mailbox. */
  sendMessage(opts: SendOptions): Promise<{ providerMessageId: string | null }>;
  /** Pull a page for sync; same as listMessages but named for the sync flow. */
  sync(opts?: ListOptions): Promise<ListResult>;
}

export interface AdapterCredentials {
  /** Decrypted OAuth refresh token — server-side only, never logged. */
  refreshToken: string;
  emailAddress: string;
}

/** Resolve a concrete adapter by mailbox type. The ONE place providers are wired. */
export function createAdapter(type: ProviderType, creds: AdapterCredentials): MailAdapter {
  switch (type) {
    case 'GMAIL':
      return new GmailAdapter(creds);
    case 'OUTLOOK':
      return new OutlookAdapter(creds);
    case 'HOSTED':
      // Reserved for a future self-hosted @domain mailbox. Same interface, so it
      // plugs in here without touching the router or UI. Not implemented yet.
      return new HostedAdapter(creds);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported mailbox type: ${_exhaustive}`);
    }
  }
}

/**
 * Build an adapter from a stored Mailbox row, decrypting its credentials. This
 * is the only path that turns an encrypted refresh token into a live client, and
 * it runs server-side exclusively.
 */
export function adapterForMailbox(mailbox: {
  type: ProviderType;
  credentials: string;
  emailAddress: string;
}): MailAdapter {
  const refreshToken = decryptToken(mailbox.credentials);
  return createAdapter(mailbox.type, { refreshToken, emailAddress: mailbox.emailAddress });
}
