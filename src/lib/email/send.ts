// Transactional email via Brevo (https://developers.brevo.com).
//
// Server-only by convention: this module reads BREVO_API_KEY (no NEXT_PUBLIC_
// prefix), so it must never be imported into a Client Component. Free plan
// allows 300 emails/day. The sender address must be a verified sender or part
// of a verified domain in the Brevo dashboard.

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export type EmailAddress = { email: string; name?: string };

export interface SendEmailOptions {
  to: EmailAddress | EmailAddress[];
  subject: string;
  /** HTML body. Provide this and/or `text`. */
  html?: string;
  /** Plain-text body. Recommended alongside `html` for deliverability. */
  text?: string;
  /** Overrides BREVO_SENDER_EMAIL / BREVO_SENDER_NAME for this message. */
  sender?: EmailAddress;
  replyTo?: EmailAddress;
  /** Brevo template id, if sending a stored template instead of inline content. */
  templateId?: number;
  /** Variables injected into a Brevo template. */
  params?: Record<string, unknown>;
}

export interface SendEmailResult {
  messageId: string;
}

function resolveSender(override?: EmailAddress): EmailAddress {
  if (override) return override;
  const email = process.env.BREVO_SENDER_EMAIL;
  if (!email) {
    throw new Error('BREVO_SENDER_EMAIL is not set (and no sender override was passed)');
  }
  return { email, name: process.env.BREVO_SENDER_NAME ?? 'DevFathom' };
}

/**
 * Send a transactional email through Brevo. Throws on a non-2xx response with
 * the Brevo error body included, so callers can log/surface the cause.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not set');
  }
  if (!options.html && !options.text && !options.templateId) {
    throw new Error('sendEmail requires one of: html, text, or templateId');
  }

  const to = Array.isArray(options.to) ? options.to : [options.to];

  const payload: Record<string, unknown> = {
    sender: resolveSender(options.sender),
    to,
    subject: options.subject,
  };
  if (options.html) payload.htmlContent = options.html;
  if (options.text) payload.textContent = options.text;
  if (options.replyTo) payload.replyTo = options.replyTo;
  if (options.templateId) payload.templateId = options.templateId;
  if (options.params) payload.params = options.params;

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo send failed (HTTP ${res.status}): ${body}`);
  }

  const data = (await res.json()) as { messageId?: string };
  return { messageId: data.messageId ?? '' };
}
