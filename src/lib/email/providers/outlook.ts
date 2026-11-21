import { Client } from '@microsoft/microsoft-graph-client/lib/src/Client.js';
import type {
  AdapterCredentials,
  ListOptions,
  ListResult,
  MailAdapter,
  NormalizedMessage,
  SendOptions,
} from '../adapter';
import { getMicrosoftAccessToken } from '../oauth';

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  receivedDateTime?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string };
}

const LIST_SELECT =
  'id,conversationId,subject,bodyPreview,isRead,hasAttachments,receivedDateTime,from,toRecipients,ccRecipients';

/** Outlook-backed {@link MailAdapter} (Microsoft Graph). */
export class OutlookAdapter implements MailAdapter {
  private accessToken: string | null = null;

  constructor(private readonly creds: AdapterCredentials) {}

  private async token(): Promise<string> {
    if (!this.accessToken) {
      this.accessToken = await getMicrosoftAccessToken(this.creds.refreshToken);
    }
    return this.accessToken;
  }

  private client(): Client {
    return Client.init({
      authProvider: (done) => {
        this.token()
          .then((t) => done(null, t))
          .catch((e) => done(e as Error, null));
      },
    });
  }

  async listMessages(opts: ListOptions = {}): Promise<ListResult> {
    const client = this.client();
    const res = opts.pageToken
      ? await client.api(opts.pageToken).get()
      : await client
          .api('/me/mailFolders/inbox/messages')
          .top(opts.limit ?? 30)
          .select(LIST_SELECT)
          .orderby('receivedDateTime DESC')
          .get();
    const value: GraphMessage[] = res.value ?? [];
    return {
      messages: value.map((m) => normalize(m)),
      nextPageToken: (res['@odata.nextLink'] as string | undefined) ?? null,
    };
  }

  async sync(opts: ListOptions = {}): Promise<ListResult> {
    return this.listMessages(opts);
  }

  async getMessage(providerMessageId: string): Promise<NormalizedMessage | null> {
    const client = this.client();
    const msg: GraphMessage = await client
      .api(`/me/messages/${providerMessageId}`)
      .select(`${LIST_SELECT},body`)
      .get();
    if (!msg) return null;
    return normalize(msg);
  }

  async sendMessage(opts: SendOptions): Promise<{ providerMessageId: string | null }> {
    const client = this.client();
    await client.api('/me/sendMail').post({
      message: {
        subject: opts.subject,
        body: { contentType: 'HTML', content: opts.html },
        toRecipients: opts.to.map((a) => ({ emailAddress: { address: a } })),
        ccRecipients: (opts.cc ?? []).map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: true,
    });
    // Graph sendMail returns 202 Accepted with no body / id.
    return { providerMessageId: null };
  }
}

// ---------------------------------------------------------------------------

function addr(r?: GraphRecipient): string {
  return r?.emailAddress?.address ?? '';
}

function normalize(m: GraphMessage): NormalizedMessage {
  const isHtml = (m.body?.contentType ?? '').toLowerCase() === 'html';
  return {
    providerMessageId: m.id,
    threadId: m.conversationId ?? null,
    fromAddr: addr(m.from),
    toAddrs: (m.toRecipients ?? []).map(addr).filter(Boolean),
    ccAddrs: (m.ccRecipients ?? []).map(addr).filter(Boolean),
    subject: m.subject || null,
    snippet: m.bodyPreview ?? null,
    bodyHtml: m.body && isHtml ? (m.body.content ?? null) : null,
    bodyText: m.body && !isHtml ? (m.body.content ?? null) : null,
    isRead: m.isRead ?? false,
    hasAttachments: m.hasAttachments ?? false,
    sentAt: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
  };
}
