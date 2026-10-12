// DevFathom email — public surface.
//
// Usage:
//   import { sendEmail, templates } from '@/lib/email';
//   const mail = templates.taskAssigned({ ... });
//   await sendEmail({ to: { email }, subject: mail.subject, html: mail.html, text: mail.text });
//
// Or via the higher-level dispatch in @/lib/notifications, which also writes an
// in-app Notification row.

export { sendEmail } from './send';
export type { EmailAddress, SendEmailOptions, SendEmailResult } from './send';

export * as templates from './templates';
export type { EmailContent } from './templates';

export { appUrl, logoUrl, palette, fonts } from './theme';
