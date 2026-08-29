// Transactional email via Brevo (https://developers.brevo.com).
//
// Server-only by convention: this module reads BREVO_API_KEY (no NEXT_PUBLIC_
// prefix), so it must never be imported into a Client Component. Free plan
// allows 300 emails/day. The sender address must be a verified sender or part
// of a verified domain in the Brevo dashboard.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

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

async function appendCapturedEmail(path: string, options: SendEmailOptions): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error('EMAIL_CAPTURE_FILE must be an absolute path');
  }

  const file = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );

  try {
    const initialStat = await file.stat();
    if (!initialStat.isFile() || initialStat.nlink !== 1) {
      throw new Error('EMAIL_CAPTURE_FILE must be a regular file with exactly one link');
    }

    await file.chmod(0o600);
    const protectedStat = await file.stat();
    if ((protectedStat.mode & 0o777) !== 0o600) {
      throw new Error('EMAIL_CAPTURE_FILE permissions could not be restricted to 0600');
    }

    const payload = Buffer.from(JSON.stringify(options));
    const record = Buffer.concat([
      Buffer.from(`${payload.byteLength}:`),
      payload,
      Buffer.from('\n'),
    ]);
    const { bytesWritten } = await file.write(record);
    if (bytesWritten !== record.byteLength) {
      throw new Error('Incomplete email capture record write');
    }
  } finally {
    await file.close();
  }
}

/**
 * Send a transactional email through Brevo. Throws on a non-2xx response with
 * the Brevo error body included, so callers can log/surface the cause.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  if (!options.html && !options.text && !options.templateId) {
    throw new Error('sendEmail requires one of: html, text, or templateId');
  }

  const to = Array.isArray(options.to) ? options.to : [options.to];
  if (process.env.EMAIL_DELIVERY_MODE === 'capture') {
    const captureFile = process.env.EMAIL_CAPTURE_FILE;
    if (captureFile) {
      await appendCapturedEmail(captureFile, { ...options, to });
      return { messageId: `captured-${Date.now()}` };
    }

    console.info('[email:capture]', { recipientCount: to.length });
    return { messageId: `captured-${Date.now()}` };
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY is not set');

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
