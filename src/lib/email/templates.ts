// Typed email builders. Each returns { subject, html, text }. Templates are pure:
// callers pass already-formatted, display-ready strings (dates, money, deep
// links). Composition uses the design-system helpers in ./layout.

import {
  renderDocument,
  eyebrow,
  heading,
  paragraph,
  button,
  badge,
  detailCard,
  callout,
  quote,
  esc,
  type Tone,
  type MetaRow,
} from './layout';
import { palette } from './theme';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const firstName = (name: string) => esc(name.trim().split(/\s+/)[0] || 'there');

/** Map a task priority label to a brand tone for its badge. */
export function priorityTone(priority?: string): Tone {
  switch ((priority ?? '').toUpperCase()) {
    case 'URGENT':
    case 'CRITICAL':
    case 'HIGH':
      return 'danger';
    case 'MEDIUM':
      return 'warning';
    case 'LOW':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// Build a plain-text body. Keeps deliverability healthy and is the fallback for
// text-only clients.
function text(lines: Array<string | false | undefined>): string {
  return lines.filter(Boolean).join('\n') + '\n\n—\nDevFathom · dev-fathom-hub.vercel.app';
}

// ---------------------------------------------------------------------------
// Onboarding & security
// ---------------------------------------------------------------------------

export function welcome(p: {
  name: string;
  workspace?: string;
  role?: string;
  email: string;
  tempPassword?: string;
  loginUrl: string;
  inviterName?: string;
}): EmailContent {
  const rows: MetaRow[] = [
    { label: 'Workspace', value: p.workspace ?? 'DevFathom' },
    { label: 'Email', value: p.email },
  ];
  if (p.role) rows.push({ label: 'Role', value: p.role });

  const creds = p.tempPassword
    ? callout(
        `Your temporary password is <strong style="font-family:monospace;color:${palette.abyss800};">${esc(p.tempPassword)}</strong> — sign in with it, then update it anytime from Settings.`,
        'brass'
      )
    : '';

  const intro = p.inviterName
    ? `${esc(p.inviterName)} added you to the DevFathom workspace.`
    : `Your DevFathom account is ready.`;

  return {
    subject: `Welcome to DevFathom${p.workspace ? ` · ${p.workspace}` : ''}`,
    html: renderDocument({
      preheader: `${intro} Sign in to get started.`,
      body: [
        eyebrow('Welcome aboard'),
        heading(`Welcome to DevFathom, ${firstName(p.name)}`),
        paragraph(
          `${intro} It's your team's command surface — projects, tasks, meetings, finance and people, in one place.`
        ),
        detailCard(rows),
        creds,
        button('Open DevFathom', p.loginUrl),
      ].join(''),
      footnote: `If you weren't expecting this, you can safely ignore the email.`,
    }),
    text: text([
      `Welcome to DevFathom, ${p.name.split(' ')[0]}`,
      ``,
      intro.replace(/<[^>]+>/g, ''),
      ``,
      `Email: ${p.email}`,
      p.role && `Role: ${p.role}`,
      p.tempPassword &&
        `Temporary password: ${p.tempPassword} (change it from Settings after signing in)`,
      ``,
      `Open DevFathom: ${p.loginUrl}`,
    ]),
  };
}

export function passwordReset(p: {
  name: string;
  resetUrl: string;
  expiresLabel?: string;
}): EmailContent {
  return {
    subject: `Reset your DevFathom password`,
    html: renderDocument({
      preheader: `A password reset was requested for your account.`,
      body: [
        eyebrow('Security'),
        heading('Reset your password'),
        paragraph(
          `Hi ${firstName(p.name)} — we received a request to reset your DevFathom password. Click below to choose a new one${
            p.expiresLabel ? `. This link expires ${esc(p.expiresLabel)}` : ''
          }.`
        ),
        button('Reset password', p.resetUrl),
        callout(
          `If you didn't request this, no action is needed — your password stays unchanged.`,
          'neutral'
        ),
      ].join(''),
    }),
    text: text([
      `Reset your DevFathom password`,
      ``,
      `Hi ${p.name.split(' ')[0]} — reset your password here:`,
      p.resetUrl,
      p.expiresLabel && `This link expires ${p.expiresLabel}.`,
      ``,
      `Didn't request it? You can ignore this email.`,
    ]),
  };
}

/**
 * DEV-974: a member's sign-in email changed. The OLD address is told so a change
 * the member did not make is noticed; the NEW address is told too and, when someone
 * else made the change, gets the link to confirm it before it can be used to sign in.
 */
export function signInEmailChanged(p: {
  name: string;
  from: string;
  to: string;
  byName?: string;
  audience: 'old' | 'new';
  confirmUrl?: string;
  expiresLabel?: string;
}): EmailContent {
  const who = p.byName ? ` by ${p.byName}` : '';
  const rows: MetaRow[] = [
    { label: 'Previous email', value: p.from },
    { label: 'New email', value: p.to },
  ];
  const confirming = p.audience === 'new' && Boolean(p.confirmUrl);
  const lead =
    p.audience === 'old'
      ? `The sign-in email for your DevFathom account was changed${who}. Sign-in and password resets now go to the new address.`
      : `This address is now the sign-in email for your DevFathom account${who ? `, changed${who}` : ''}.`;
  const next = confirming
    ? `Confirm this address and choose a password to sign in again${
        p.expiresLabel ? `. The link expires ${p.expiresLabel}` : ''
      }.`
    : undefined;
  const warning =
    p.audience === 'old'
      ? `If you did not expect this, contact your workspace owner straight away.`
      : `If you do not recognise this account, you can ignore this email.`;
  return {
    subject:
      p.audience === 'old'
        ? 'Your DevFathom sign-in email was changed'
        : confirming
          ? 'Confirm your new DevFathom sign-in email'
          : 'Your DevFathom sign-in email was changed',
    html: renderDocument({
      preheader: lead,
      body: [
        eyebrow('Security'),
        heading(confirming ? 'Confirm your new sign-in email' : 'Your sign-in email changed'),
        paragraph(`Hi ${firstName(p.name)} — ${esc(lead)}`, { html: true }),
        detailCard(rows),
        next ? paragraph(next) : '',
        confirming && p.confirmUrl ? button('Confirm email', p.confirmUrl) : '',
        callout(esc(warning), p.audience === 'old' ? 'warning' : 'neutral'),
      ].join(''),
    }),
    text: text([
      confirming
        ? 'Confirm your new DevFathom sign-in email'
        : 'Your DevFathom sign-in email changed',
      ``,
      `Hi ${p.name.split(' ')[0]} — ${lead}`,
      `Previous email: ${p.from}`,
      `New email: ${p.to}`,
      next && ``,
      next,
      confirming && p.confirmUrl,
      ``,
      warning,
    ]),
  };
}

export function inviteMember(p: {
  name: string;
  inviterName?: string;
  role?: string;
  workspace?: string;
  acceptUrl: string;
  expiresLabel?: string;
}): EmailContent {
  const workspace = p.workspace ?? 'DevFathom';
  const firstName = p.name?.trim().split(/\s+/)[0] || 'there';
  const rows: MetaRow[] = [{ label: 'Workspace', value: workspace }];
  if (p.role) rows.push({ label: 'Role', value: p.role });

  const invitedByHtml = p.inviterName
    ? `${esc(p.inviterName)} has invited you to join the team.`
    : `You've been invited to join the team.`;
  const invitedByText = p.inviterName
    ? `${p.inviterName} has invited you to join the team.`
    : `You've been invited to join the team.`;

  return {
    subject: `Welcome to ${workspace} — your invitation`,
    html: renderDocument({
      preheader: `${invitedByText} Accept to set your password and finish your profile.`,
      body: [
        eyebrow('Welcome aboard'),
        heading(`Welcome to ${esc(workspace)}, ${esc(firstName)}`),
        paragraph(
          `We're glad to have you. ${invitedByHtml} ${esc(
            workspace
          )} is where the team plans projects, runs meetings, tracks work, and stays in sync — and there's a seat waiting for you.`,
          { html: true }
        ),
        detailCard(rows),
        paragraph(
          `To get started, accept your invitation below. You'll choose your own password and add a few details — once that's done, you're all set.`
        ),
        button('Accept invitation & set password', p.acceptUrl),
        callout(
          `This invitation link is unique to you${
            p.expiresLabel ? ` and expires ${esc(p.expiresLabel)}` : ''
          }. Please don't forward it.`,
          'neutral'
        ),
      ].join(''),
      footnote: `If you weren't expecting this, you can safely ignore the email.`,
    }),
    text: text([
      `Welcome to ${workspace}, ${firstName}`,
      ``,
      `We're glad to have you. ${invitedByText}`,
      `${workspace} is where the team plans projects, runs meetings, tracks work, and stays in sync.`,
      ``,
      `To get started, accept your invitation (set a password and finish your profile):`,
      p.acceptUrl,
      p.expiresLabel && `This link expires ${p.expiresLabel}.`,
      ``,
      `Didn't expect this? You can safely ignore this email.`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function taskAssigned(p: {
  assigneeName: string;
  taskTitle: string;
  projectName: string;
  boardName?: string;
  priority?: string;
  dueDate?: string;
  assignedByName: string;
  description?: string;
  url: string;
}): EmailContent {
  const rows: MetaRow[] = [{ label: 'Project', value: p.projectName }];
  if (p.boardName) rows.push({ label: 'Board', value: p.boardName });
  if (p.priority)
    rows.push({
      label: 'Priority',
      value: badge(p.priority, priorityTone(p.priority)),
      valueHtml: true,
    });
  if (p.dueDate) rows.push({ label: 'Due', value: p.dueDate });
  rows.push({ label: 'Assigned by', value: p.assignedByName });

  return {
    subject: `New task: ${p.taskTitle}`,
    html: renderDocument({
      preheader: `${p.assignedByName} assigned you "${p.taskTitle}" in ${p.projectName}.`,
      body: [
        eyebrow('Task assigned'),
        heading(p.taskTitle),
        paragraph(
          `${esc(p.assignedByName)} assigned this task to you${
            p.projectName ? ` in <strong>${esc(p.projectName)}</strong>` : ''
          }.`,
          { html: true }
        ),
        detailCard(rows),
        p.description ? quote(p.description) : '',
        button('View task', p.url),
      ].join(''),
    }),
    text: text([
      `New task assigned: ${p.taskTitle}`,
      ``,
      `${p.assignedByName} assigned this to you in ${p.projectName}.`,
      p.boardName && `Board: ${p.boardName}`,
      p.priority && `Priority: ${p.priority}`,
      p.dueDate && `Due: ${p.dueDate}`,
      p.description && `\n${p.description}`,
      ``,
      `View task: ${p.url}`,
    ]),
  };
}

export function taskStatusChanged(p: {
  taskTitle: string;
  fromStatus: string;
  toStatus: string;
  projectName: string;
  byName: string;
  url: string;
}): EmailContent {
  return {
    subject: `${p.taskTitle} → ${p.toStatus}`,
    html: renderDocument({
      preheader: `${p.byName} moved "${p.taskTitle}" to ${p.toStatus}.`,
      body: [
        eyebrow('Status update'),
        heading(p.taskTitle),
        paragraph(
          `${esc(p.byName)} moved this task from <strong>${esc(p.fromStatus)}</strong> to <strong>${esc(
            p.toStatus
          )}</strong> in ${esc(p.projectName)}.`,
          { html: true }
        ),
        detailCard([
          { label: 'From', value: badge(p.fromStatus, 'neutral'), valueHtml: true },
          { label: 'To', value: badge(p.toStatus, 'brand'), valueHtml: true },
          { label: 'Project', value: p.projectName },
        ]),
        button('View task', p.url),
      ].join(''),
    }),
    text: text([
      `${p.taskTitle}: ${p.fromStatus} → ${p.toStatus}`,
      ``,
      `${p.byName} updated this task in ${p.projectName}.`,
      ``,
      `View task: ${p.url}`,
    ]),
  };
}

export function taskDeadline(p: {
  assigneeName: string;
  taskTitle: string;
  projectName: string;
  dueDate: string;
  overdue: boolean;
  priority?: string;
  url: string;
}): EmailContent {
  const tone: Tone = p.overdue ? 'danger' : 'warning';
  const kicker = p.overdue ? 'Overdue' : 'Deadline approaching';
  const line = p.overdue
    ? `This task was due ${esc(p.dueDate)} and is still open.`
    : `This task is due ${esc(p.dueDate)}.`;
  return {
    subject: p.overdue ? `Overdue: ${p.taskTitle}` : `Due soon: ${p.taskTitle}`,
    html: renderDocument({
      preheader: line.replace(/<[^>]+>/g, ''),
      body: [
        eyebrow(kicker, tone === 'danger' ? palette.destructive : palette.warning),
        heading(p.taskTitle),
        callout(`<strong>${line}</strong>`, tone),
        detailCard([
          { label: 'Project', value: p.projectName },
          { label: 'Due', value: p.dueDate },
          ...(p.priority
            ? [
                {
                  label: 'Priority',
                  value: badge(p.priority, priorityTone(p.priority)),
                  valueHtml: true,
                },
              ]
            : []),
        ]),
        button('Open task', p.url, tone),
      ].join(''),
    }),
    text: text([
      `${p.overdue ? 'OVERDUE' : 'DUE SOON'}: ${p.taskTitle}`,
      ``,
      line.replace(/<[^>]+>/g, ''),
      `Project: ${p.projectName}`,
      ``,
      `Open task: ${p.url}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Conversation — mentions & comments
// ---------------------------------------------------------------------------

export function mention(p: {
  recipientName: string;
  actorName: string;
  contextLabel: string; // e.g. "task “Ship billing”" or "the note “Q3 plan”"
  excerpt: string;
  url: string;
}): EmailContent {
  return {
    subject: `${p.actorName} mentioned you`,
    html: renderDocument({
      preheader: `${p.actorName} mentioned you in ${p.contextLabel}.`,
      body: [
        eyebrow('You were mentioned'),
        heading(`${p.actorName} mentioned you`),
        paragraph(`In ${esc(p.contextLabel)}:`, { html: false }),
        quote(p.excerpt, p.actorName),
        button('View thread', p.url),
      ].join(''),
    }),
    text: text([
      `${p.actorName} mentioned you in ${p.contextLabel}`,
      ``,
      `"${p.excerpt}"`,
      ``,
      `View: ${p.url}`,
    ]),
  };
}

export function comment(p: {
  recipientName: string;
  actorName: string;
  onLabel: string; // e.g. task title
  excerpt: string;
  url: string;
}): EmailContent {
  return {
    subject: `New comment on ${p.onLabel}`,
    html: renderDocument({
      preheader: `${p.actorName} commented on ${p.onLabel}.`,
      body: [
        eyebrow('New comment'),
        heading(p.onLabel),
        paragraph(`${esc(p.actorName)} left a comment:`),
        quote(p.excerpt, p.actorName),
        button('Reply', p.url),
      ].join(''),
    }),
    text: text([
      `New comment on ${p.onLabel}`,
      ``,
      `${p.actorName}: "${p.excerpt}"`,
      ``,
      `Reply: ${p.url}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export function meetingInvite(p: {
  recipientName: string;
  title: string;
  organizerName: string;
  whenLabel: string;
  durationLabel?: string;
  location?: string;
  joinUrl?: string;
  agenda?: string;
  url: string;
}): EmailContent {
  const rows: MetaRow[] = [{ label: 'When', value: p.whenLabel }];
  if (p.durationLabel) rows.push({ label: 'Duration', value: p.durationLabel });
  rows.push({ label: 'Location', value: p.location ?? (p.joinUrl ? 'Online' : '—') });
  rows.push({ label: 'Organizer', value: p.organizerName });

  return {
    subject: `Meeting invite: ${p.title}`,
    html: renderDocument({
      preheader: `${p.organizerName} invited you · ${p.whenLabel}.`,
      body: [
        eyebrow('Meeting invite'),
        heading(p.title),
        paragraph(`${esc(p.organizerName)} invited you to a meeting.`),
        detailCard(rows),
        p.agenda ? quote(p.agenda) : '',
        p.joinUrl ? button('Join meeting', p.joinUrl) : button('View meeting', p.url),
      ].join(''),
    }),
    text: text([
      `Meeting invite: ${p.title}`,
      ``,
      `${p.organizerName} invited you.`,
      `When: ${p.whenLabel}`,
      p.durationLabel && `Duration: ${p.durationLabel}`,
      p.location && `Location: ${p.location}`,
      p.joinUrl && `Join: ${p.joinUrl}`,
      ``,
      `Details: ${p.url}`,
    ]),
  };
}

/**
 * Guest invitation to ONE meeting occurrence (WHA-235).
 *
 * DELIBERATELY NOT A ONE-CLICK LINK, and that is the whole difference between
 * this and `invitation` above. An invite token is designed to travel in a URL;
 * a live meeting credential is not — a URL lands in browser history, `Referer`
 * headers, proxy and server access logs, and chat-app link previews.
 *
 * So this template carries two separate things and never combines them:
 *   - `joinUrl`, which is the occurrence's `publicId` and nothing else. It is a
 *     LOCATOR: holding it proves nothing.
 *   - `passcode`, rendered as text for the guest to TYPE. It is the credential.
 *
 * A caller MUST NOT append the passcode to `joinUrl`. The parameters are
 * separate here so that doing so has to be a deliberate act rather than a
 * convenience.
 */
export function meetingGuestInvite(p: {
  recipientName: string;
  title: string;
  organizerName: string;
  whenLabel: string;
  durationLabel?: string;
  /** Locator only — `/join/<publicId>`. Never carries the passcode. */
  joinUrl: string;
  /** Shown once. Typed by the guest, never placed in a link. */
  passcode: string;
  expiresLabel: string;
  agenda?: string;
}): EmailContent {
  const rows: MetaRow[] = [{ label: 'When', value: p.whenLabel }];
  if (p.durationLabel) rows.push({ label: 'Duration', value: p.durationLabel });
  rows.push({ label: 'Host', value: p.organizerName });
  rows.push({ label: 'Passcode valid until', value: p.expiresLabel });

  return {
    subject: `You're invited: ${p.title}`,
    html: renderDocument({
      preheader: `${p.organizerName} invited you as a guest · ${p.whenLabel}.`,
      body: [
        eyebrow('Guest invite'),
        heading(p.title),
        paragraph(`${esc(p.organizerName)} invited you to join as a guest.`),
        detailCard(rows),
        p.agenda ? quote(p.agenda) : '',
        button('Open the meeting', p.joinUrl),
        paragraph(
          `You'll be asked for this passcode: <strong>${esc(p.passcode)}</strong>. ` +
            `It is shown only in this email, works only for this one meeting, and ` +
            `expires afterwards. Please don't forward it.`
        ),
      ].join(''),
    }),
    text: text([
      `You're invited: ${p.title}`,
      ``,
      `${p.organizerName} invited you to join as a guest.`,
      `When: ${p.whenLabel}`,
      p.durationLabel && `Duration: ${p.durationLabel}`,
      ``,
      `Open the meeting: ${p.joinUrl}`,
      `Passcode: ${p.passcode}`,
      `Passcode valid until: ${p.expiresLabel}`,
      ``,
      `The passcode is shown only in this email and works only for this one`,
      `meeting. Please don't forward it.`,
    ]),
  };
}

export function meetingReminder(p: {
  title: string;
  whenLabel: string;
  startsInLabel: string; // "in 15 minutes"
  joinUrl?: string;
  url: string;
}): EmailContent {
  return {
    subject: `Starting ${p.startsInLabel}: ${p.title}`,
    html: renderDocument({
      preheader: `${p.title} starts ${p.startsInLabel}.`,
      body: [
        eyebrow('Reminder'),
        heading(p.title),
        callout(`<strong>Starts ${esc(p.startsInLabel)}</strong> · ${esc(p.whenLabel)}`, 'brand'),
        p.joinUrl ? button('Join now', p.joinUrl) : button('View meeting', p.url),
      ].join(''),
    }),
    text: text([
      `Reminder: ${p.title} starts ${p.startsInLabel}`,
      `When: ${p.whenLabel}`,
      p.joinUrl && `Join: ${p.joinUrl}`,
      ``,
      `Details: ${p.url}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export function invoiceIssued(p: {
  recipientName: string;
  invoiceNumber: string;
  clientName: string;
  amountLabel: string;
  dueDate: string;
  url: string;
}): EmailContent {
  return {
    subject: `Invoice ${p.invoiceNumber} · ${p.amountLabel}`,
    html: renderDocument({
      preheader: `Invoice ${p.invoiceNumber} for ${p.clientName} — ${p.amountLabel}, due ${p.dueDate}.`,
      body: [
        eyebrow('Invoice issued'),
        heading(`Invoice ${p.invoiceNumber}`),
        paragraph(`A new invoice has been issued for <strong>${esc(p.clientName)}</strong>.`, {
          html: true,
        }),
        detailCard([
          { label: 'Client', value: p.clientName },
          { label: 'Amount', value: badge(p.amountLabel, 'brass'), valueHtml: true },
          { label: 'Due', value: p.dueDate },
          { label: 'Invoice #', value: p.invoiceNumber },
        ]),
        button('View invoice', p.url),
      ].join(''),
    }),
    text: text([
      `Invoice ${p.invoiceNumber} — ${p.amountLabel}`,
      ``,
      `Client: ${p.clientName}`,
      `Due: ${p.dueDate}`,
      ``,
      `View: ${p.url}`,
    ]),
  };
}

export function invoicePaid(p: {
  invoiceNumber: string;
  clientName: string;
  amountLabel: string;
  paidDate: string;
  url: string;
}): EmailContent {
  return {
    subject: `Payment received · Invoice ${p.invoiceNumber}`,
    html: renderDocument({
      preheader: `${p.clientName} paid ${p.amountLabel} on invoice ${p.invoiceNumber}.`,
      body: [
        eyebrow('Payment received', palette.success),
        heading(`Invoice ${p.invoiceNumber} is paid`),
        callout(
          `<strong>${esc(p.amountLabel)}</strong> received from ${esc(p.clientName)} on ${esc(p.paidDate)}.`,
          'success'
        ),
        detailCard([
          { label: 'Client', value: p.clientName },
          { label: 'Amount', value: p.amountLabel },
          { label: 'Paid', value: p.paidDate },
        ]),
        button('View invoice', p.url),
      ].join(''),
    }),
    text: text([
      `Payment received — Invoice ${p.invoiceNumber}`,
      ``,
      `${p.clientName} paid ${p.amountLabel} on ${p.paidDate}.`,
      ``,
      `View: ${p.url}`,
    ]),
  };
}

export function invoiceOverdue(p: {
  invoiceNumber: string;
  clientName: string;
  amountLabel: string;
  dueDate: string;
  daysOverdueLabel: string;
  url: string;
}): EmailContent {
  return {
    subject: `Overdue · Invoice ${p.invoiceNumber}`,
    html: renderDocument({
      preheader: `Invoice ${p.invoiceNumber} for ${p.clientName} is ${p.daysOverdueLabel} overdue.`,
      body: [
        eyebrow('Overdue', palette.destructive),
        heading(`Invoice ${p.invoiceNumber} is overdue`),
        callout(
          `<strong>${esc(p.amountLabel)}</strong> from ${esc(p.clientName)} was due ${esc(p.dueDate)} — now ${esc(p.daysOverdueLabel)} overdue.`,
          'danger'
        ),
        detailCard([
          { label: 'Client', value: p.clientName },
          { label: 'Amount', value: p.amountLabel },
          { label: 'Was due', value: p.dueDate },
        ]),
        button('Review invoice', p.url, 'danger'),
      ].join(''),
    }),
    text: text([
      `OVERDUE — Invoice ${p.invoiceNumber}`,
      ``,
      `${p.amountLabel} from ${p.clientName}, due ${p.dueDate} (${p.daysOverdueLabel} overdue).`,
      ``,
      `Review: ${p.url}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Projects, clients, HR
// ---------------------------------------------------------------------------

export function projectStatusChanged(p: {
  projectName: string;
  fromStatus: string;
  toStatus: string;
  byName: string;
  url: string;
}): EmailContent {
  return {
    subject: `${p.projectName} → ${p.toStatus}`,
    html: renderDocument({
      preheader: `${p.byName} set ${p.projectName} to ${p.toStatus}.`,
      body: [
        eyebrow('Project update'),
        heading(p.projectName),
        paragraph(`${esc(p.byName)} changed the project status.`),
        detailCard([
          { label: 'From', value: badge(p.fromStatus, 'neutral'), valueHtml: true },
          { label: 'To', value: badge(p.toStatus, 'brand'), valueHtml: true },
        ]),
        button('Open project', p.url),
      ].join(''),
    }),
    text: text([
      `${p.projectName}: ${p.fromStatus} → ${p.toStatus}`,
      `Changed by ${p.byName}.`,
      ``,
      `Open: ${p.url}`,
    ]),
  };
}

export function clientAdded(p: {
  recipientName: string;
  clientName: string;
  addedByName: string;
  industry?: string;
  url: string;
}): EmailContent {
  const rows: MetaRow[] = [{ label: 'Client', value: p.clientName }];
  if (p.industry) rows.push({ label: 'Industry', value: p.industry });
  rows.push({ label: 'Added by', value: p.addedByName });
  return {
    subject: `New client: ${p.clientName}`,
    html: renderDocument({
      preheader: `${p.addedByName} added ${p.clientName} to the workspace.`,
      body: [
        eyebrow('New client'),
        heading(p.clientName),
        paragraph(`${esc(p.addedByName)} added a new client to DevFathom.`),
        detailCard(rows),
        button('View client', p.url),
      ].join(''),
    }),
    text: text([`New client: ${p.clientName}`, `Added by ${p.addedByName}.`, ``, `View: ${p.url}`]),
  };
}

export function leaveRequest(p: {
  recipientName: string;
  employeeName: string;
  leaveType: string;
  rangeLabel: string;
  status: string; // SUBMITTED / APPROVED / DECLINED
  url: string;
}): EmailContent {
  const tone: Tone =
    p.status.toUpperCase() === 'APPROVED'
      ? 'success'
      : p.status.toUpperCase() === 'DECLINED'
        ? 'danger'
        : 'neutral';
  return {
    subject: `Time off · ${p.employeeName} · ${p.status}`,
    html: renderDocument({
      preheader: `${p.employeeName}'s ${p.leaveType} request — ${p.status}.`,
      body: [
        eyebrow('Time off'),
        heading(`${p.leaveType} request`),
        paragraph(`${esc(p.employeeName)} · ${esc(p.rangeLabel)}`),
        callout(`Status: <strong>${esc(p.status)}</strong>`, tone),
        button('Review request', p.url),
      ].join(''),
    }),
    text: text([
      `Time off — ${p.employeeName} (${p.status})`,
      `${p.leaveType}: ${p.rangeLabel}`,
      ``,
      `Review: ${p.url}`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Digest + generic alert
// ---------------------------------------------------------------------------

export function weeklyDigest(p: {
  recipientName: string;
  weekLabel: string;
  stats: Array<{ label: string; value: string }>;
  highlights: string[];
  url: string;
}): EmailContent {
  const statRows = p.stats.map((s) => ({ label: s.label, value: s.value }));
  const highlightHtml = p.highlights.length
    ? `<ul style="margin:0 0 26px;padding-left:20px;font-family:${"'IBM Plex Sans', sans-serif"};font-size:15px;line-height:1.7;color:${palette.slate700};">${p.highlights
        .map((h) => `<li style="margin:0 0 6px;">${esc(h)}</li>`)
        .join('')}</ul>`
    : '';
  return {
    subject: `Your week at DevFathom · ${p.weekLabel}`,
    html: renderDocument({
      preheader: `Your DevFathom summary for ${p.weekLabel}.`,
      body: [
        eyebrow('Weekly digest'),
        heading(`This week, ${firstName(p.recipientName)}`),
        paragraph(`Here's how the workspace moved over ${esc(p.weekLabel)}.`),
        detailCard(statRows),
        highlightHtml,
        button('Open dashboard', p.url),
      ].join(''),
    }),
    text: text([
      `Your week at DevFathom — ${p.weekLabel}`,
      ``,
      ...p.stats.map((s) => `${s.label}: ${s.value}`),
      ``,
      ...p.highlights.map((h) => `• ${h}`),
      ``,
      `Dashboard: ${p.url}`,
    ]),
  };
}

export function alert(p: {
  title: string;
  message: string;
  tone?: Tone;
  kicker?: string;
  details?: MetaRow[];
  ctaLabel?: string;
  ctaUrl?: string;
}): EmailContent {
  const tone = p.tone ?? 'neutral';
  const kickerColor =
    tone === 'danger'
      ? palette.destructive
      : tone === 'success'
        ? palette.success
        : tone === 'warning'
          ? palette.warning
          : palette.brass;
  return {
    subject: p.title,
    html: renderDocument({
      preheader: p.message.slice(0, 140),
      body: [
        eyebrow(p.kicker ?? 'Notice', kickerColor),
        heading(p.title),
        callout(esc(p.message), tone),
        p.details && p.details.length ? detailCard(p.details) : '',
        p.ctaLabel && p.ctaUrl
          ? button(p.ctaLabel, p.ctaUrl, tone === 'neutral' ? 'brand' : tone)
          : '',
      ].join(''),
    }),
    text: text([p.title, ``, p.message, p.ctaUrl && `\n${p.ctaLabel ?? 'Open'}: ${p.ctaUrl}`]),
  };
}

export function accountDeactivated(p: {
  name: string;
  byName?: string;
  effectiveLabel?: string;
  supportEmail?: string;
  reason?: string;
}): EmailContent {
  const who = p.byName ? ` by ${esc(p.byName)}` : '';
  const when = p.effectiveLabel ? `, effective ${esc(p.effectiveLabel)}` : '';
  const reason = p.reason?.trim();
  return {
    subject: 'Your DevFathom access has been deactivated',
    html: renderDocument({
      preheader: 'Your DevFathom account has been deactivated.',
      body: [
        eyebrow('Account update', palette.destructive),
        heading('Your access has ended'),
        paragraph(
          `Hi ${firstName(p.name)} — your DevFathom account has been deactivated${who}${when}. You no longer have access to the hub.`,
          { html: true }
        ),
        reason ? callout(`<strong>Reason provided:</strong> ${esc(reason)}`, 'warning') : '',
        callout(
          `If you believe this is a mistake, please contact ${
            p.supportEmail ? `<strong>${esc(p.supportEmail)}</strong>` : 'your administrator'
          }.`,
          'neutral'
        ),
      ].join(''),
      footnote: 'This is an automated message from DevFathom.',
    }),
    text: text([
      'Your DevFathom access has been deactivated',
      ``,
      `Hi ${p.name.split(' ')[0]} — your DevFathom account has been deactivated${
        p.byName ? ` by ${p.byName}` : ''
      }${p.effectiveLabel ? `, effective ${p.effectiveLabel}` : ''}.`,
      `You no longer have access to the hub.`,
      reason ? `` : false,
      reason ? `Reason provided: ${reason}` : false,
      ``,
      p.supportEmail
        ? `Questions? Contact ${p.supportEmail}.`
        : `Questions? Contact your administrator.`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Resignations
// ---------------------------------------------------------------------------

// Notify HR / admins that a team member has submitted a resignation that needs
// review. Carries the stated reason and the employee's proposed last day.
export function resignationSubmitted(p: {
  employeeName: string;
  reason: string;
  proposedLastDayLabel: string;
  reviewUrl: string;
}): EmailContent {
  return {
    subject: `Resignation submitted · ${p.employeeName}`,
    html: renderDocument({
      preheader: `${p.employeeName} submitted a resignation — proposed last day ${p.proposedLastDayLabel}.`,
      body: [
        eyebrow('Resignation', palette.warning),
        heading(`${esc(p.employeeName)} has resigned`),
        paragraph(
          `<strong>${esc(p.employeeName)}</strong> submitted a resignation and it's awaiting your review.`,
          { html: true }
        ),
        detailCard([
          { label: 'Employee', value: p.employeeName },
          { label: 'Proposed last day', value: p.proposedLastDayLabel },
        ]),
        quote(p.reason),
        button('Review resignation', p.reviewUrl),
      ].join(''),
    }),
    text: text([
      `Resignation submitted — ${p.employeeName}`,
      ``,
      `${p.employeeName} submitted a resignation and it's awaiting review.`,
      `Proposed last day: ${p.proposedLastDayLabel}`,
      ``,
      `Reason: ${p.reason}`,
      ``,
      `Review: ${p.reviewUrl}`,
    ]),
  };
}

// Tell an employee the outcome of their resignation. On approval, confirms the
// final working day; includes the reviewer's note when one was left.
export function resignationDecision(p: {
  recipientName: string;
  decision: 'APPROVED' | 'DECLINED';
  lastWorkingDayLabel?: string;
  reviewNote?: string;
  url: string;
}): EmailContent {
  const approved = p.decision === 'APPROVED';
  const decisionLabel = approved ? 'approved' : 'declined';
  const tone: Tone = approved ? 'success' : 'danger';
  const note = p.reviewNote?.trim();
  const intro = approved
    ? `Hi ${firstName(p.recipientName)} — your resignation has been approved. Thank you for everything you've contributed.`
    : `Hi ${firstName(p.recipientName)} — your resignation has been declined. Please reach out to HR to discuss next steps.`;
  return {
    subject: `Your resignation has been ${decisionLabel}`,
    html: renderDocument({
      preheader: `Your resignation has been ${decisionLabel}.`,
      body: [
        eyebrow('Resignation', approved ? palette.success : palette.destructive),
        heading(`Your resignation has been ${decisionLabel}`),
        paragraph(intro),
        approved && p.lastWorkingDayLabel
          ? callout(
              `Your confirmed last working day is <strong>${esc(p.lastWorkingDayLabel)}</strong>.`,
              'success'
            )
          : '',
        note ? callout(`<strong>Note from the reviewer:</strong> ${esc(note)}`, 'neutral') : '',
        button('View details', p.url, tone),
      ].join(''),
    }),
    text: text([
      `Your resignation has been ${decisionLabel}`,
      ``,
      intro,
      approved && p.lastWorkingDayLabel
        ? `Confirmed last working day: ${p.lastWorkingDayLabel}`
        : false,
      note ? `` : false,
      note ? `Note from the reviewer: ${note}` : false,
      ``,
      `View details: ${p.url}`,
    ]),
  };
}
