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
  return lines.filter(Boolean).join('\n') + '\n\n—\nDevFathom · hub.devfathom.com';
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
