import { GoogleOAuth2, gmailClient, type gmail_v1 } from '../google-gmail';
import type {
  AdapterCredentials,
  ListOptions,
  ListResult,
  MailAdapter,
  NormalizedMessage,
  SendOptions,
} from '../adapter';
import { googleConfig } from '../oauth';

/** Gmail-backed {@link MailAdapter} (Gmail REST API via googleapis). */
export class GmailAdapter implements MailAdapter {
  constructor(private readonly creds: AdapterCredentials) {}

  private client(): gmail_v1.Gmail {
    const { clientId, clientSecret, redirectUri } = googleConfig();
    const auth = new GoogleOAuth2(clientId, clientSecret, redirectUri);
    // googleapis transparently refreshes the access token from the refresh token.
    auth.setCredentials({ refresh_token: this.creds.refreshToken });
    return gmailClient(auth);
  }

  async listMessages(opts: ListOptions = {}): Promise<ListResult> {
    const gmail = this.client();
    const list = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: opts.limit ?? 30,
      pageToken: opts.pageToken ?? undefined,
    });
    const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    const messages = await Promise.all(
      ids.map(async (id) => {
        const res = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        });
        return normalize(res.data, { withBody: false });
      })
    );
    return { messages, nextPageToken: list.data.nextPageToken ?? null };
  }

  async sync(opts: ListOptions = {}): Promise<ListResult> {
    return this.listMessages(opts);
  }

  async getMessage(providerMessageId: string): Promise<NormalizedMessage | null> {
    const gmail = this.client();
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: providerMessageId,
      format: 'full',
    });
    if (!res.data) return null;
    return normalize(res.data, { withBody: true });
  }

  async sendMessage(opts: SendOptions): Promise<{ providerMessageId: string | null }> {
    const gmail = this.client();
    const headers = [
      `From: ${this.creds.emailAddress}`,
      `To: ${opts.to.join(', ')}`,
      opts.cc?.length ? `Cc: ${opts.cc.join(', ')}` : null,
      `Subject: ${opts.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
    ]
      .filter(Boolean)
      .join('\r\n');
    const raw = base64Url(Buffer.from(`${headers}\r\n\r\n${opts.html}`, 'utf8'));
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { providerMessageId: res.data.id ?? null };
  }
}

// ---------------------------------------------------------------------------

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBody(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function splitAddrs(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Recursively collect the html + plain bodies and whether any part is an attachment. */
function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc: { html: string; text: string; hasAttachments: boolean }
): void {
  if (!part) return;
  if (part.filename && part.filename.length > 0) acc.hasAttachments = true;
  const mime = part.mimeType ?? '';
  if (mime === 'text/html' && part.body?.data) acc.html ||= decodeBody(part.body.data);
  else if (mime === 'text/plain' && part.body?.data) acc.text ||= decodeBody(part.body.data);
  for (const child of part.parts ?? []) walkParts(child, acc);
}

function normalize(msg: gmail_v1.Schema$Message, opts: { withBody: boolean }): NormalizedMessage {
  const headers = msg.payload?.headers ?? [];
  const acc = { html: '', text: '', hasAttachments: false };
  if (opts.withBody) walkParts(msg.payload, acc);
  else {
    // Cheap attachment hint from the top-level part list in metadata mode.
    for (const p of msg.payload?.parts ?? []) {
      if (p.filename && p.filename.length > 0) acc.hasAttachments = true;
    }
  }

  const internal = msg.internalDate ? Number(msg.internalDate) : NaN;
  const sentAt = Number.isFinite(internal)
    ? new Date(internal)
    : new Date(header(headers, 'Date') || Date.now());

  return {
    providerMessageId: msg.id!,
    threadId: msg.threadId ?? null,
    fromAddr: header(headers, 'From'),
    toAddrs: splitAddrs(header(headers, 'To')),
    ccAddrs: splitAddrs(header(headers, 'Cc')),
    subject: header(headers, 'Subject') || null,
    snippet: msg.snippet ?? null,
    bodyHtml: opts.withBody ? acc.html || null : null,
    bodyText: opts.withBody ? acc.text || null : null,
    isRead: !(msg.labelIds ?? []).includes('UNREAD'),
    hasAttachments: acc.hasAttachments,
    sentAt,
  };
}
