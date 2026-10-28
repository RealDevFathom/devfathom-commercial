// Render every DevFathom email template with sample data.
//
//   bunx tsx scripts/email-gallery.ts                 → write HTML to .preview/emails/
//   bunx tsx scripts/email-gallery.ts --send you@x.com → also email each sample
//
// Sending prefixes subjects with "[DevFathom sample]" so previews are never
// mistaken for real alerts.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendEmail, templates } from '../src/lib/email';
import type { EmailContent } from '../src/lib/email';

const APP = 'https://dev-fathom-hub.vercel.app';

const GALLERY: Array<{ name: string; label: string; content: EmailContent }> = [
  {
    name: 'welcome',
    label: 'Welcome / invite',
    content: templates.welcome({
      name: 'Usman Khalid',
      workspace: 'DevFathom',
      role: 'Admin · Leadership',
      email: 'usman@devfathom.com',
      tempPassword: 'example-temp-password',
      loginUrl: `${APP}/login`,
      inviterName: 'Saad Ajmal',
    }),
  },
  {
    name: 'password-reset',
    label: 'Password reset',
    content: templates.passwordReset({
      name: 'Scott Meyer',
      resetUrl: `${APP}/reset?token=eyJhbGciOi`,
      expiresLabel: 'in 30 minutes',
    }),
  },
  {
    name: 'task-assigned',
    label: 'Task assigned',
    content: templates.taskAssigned({
      assigneeName: 'Usman Khalid',
      taskTitle: 'Wire Stripe webhooks for subscription lifecycle',
      projectName: 'Billing Platform',
      boardName: 'Sprint 14',
      priority: 'HIGH',
      dueDate: 'Fri, Jun 20 · 5:00 PM',
      assignedByName: 'Saad Ajmal',
      description:
        'Handle invoice.paid, customer.subscription.updated and deleted. Idempotent by event id; backfill the last 7 days once live.',
      url: `${APP}/projects/p_billing/board/b_sprint14?task=t_9921`,
    }),
  },
  {
    name: 'task-status',
    label: 'Task status changed',
    content: templates.taskStatusChanged({
      taskTitle: 'Wire Stripe webhooks for subscription lifecycle',
      fromStatus: 'In Progress',
      toStatus: 'In Review',
      projectName: 'Billing Platform',
      byName: 'Usman Khalid',
      url: `${APP}/projects/p_billing/board/b_sprint14?task=t_9921`,
    }),
  },
  {
    name: 'task-deadline',
    label: 'Task due soon',
    content: templates.taskDeadline({
      assigneeName: 'Usman Khalid',
      taskTitle: 'Finalize Q3 OKRs deck',
      projectName: 'Leadership',
      dueDate: 'tomorrow, 9:00 AM',
      overdue: false,
      priority: 'MEDIUM',
      url: `${APP}/projects/p_lead/board/b_okr?task=t_4410`,
    }),
  },
  {
    name: 'task-overdue',
    label: 'Task overdue',
    content: templates.taskDeadline({
      assigneeName: 'Usman Khalid',
      taskTitle: 'Submit SOC 2 evidence batch',
      projectName: 'Compliance',
      dueDate: 'Jun 16',
      overdue: true,
      priority: 'URGENT',
      url: `${APP}/projects/p_comp/board/b_soc2?task=t_3001`,
    }),
  },
  {
    name: 'mention',
    label: 'Mention',
    content: templates.mention({
      recipientName: 'Scott Meyer',
      actorName: 'Saad Ajmal',
      contextLabel: 'task “Wire Stripe webhooks”',
      excerpt:
        '@scott can you confirm the test clock approach before we ship? Want to avoid double-charging in the backfill.',
      url: `${APP}/projects/p_billing/board/b_sprint14?task=t_9921`,
    }),
  },
  {
    name: 'comment',
    label: 'New comment',
    content: templates.comment({
      recipientName: 'Usman Khalid',
      actorName: 'Scott Meyer',
      onLabel: 'Wire Stripe webhooks for subscription lifecycle',
      excerpt: 'Left a couple of notes on idempotency — otherwise looks great. Ready to merge after.',
      url: `${APP}/projects/p_billing/board/b_sprint14?task=t_9921`,
    }),
  },
  {
    name: 'meeting-invite',
    label: 'Meeting invite',
    content: templates.meetingInvite({
      recipientName: 'Usman Khalid',
      title: 'Q3 Roadmap Review',
      organizerName: 'Saad Ajmal',
      whenLabel: 'Thu, Jun 19 · 3:00–4:00 PM (PKT)',
      durationLabel: '60 minutes',
      location: 'Google Meet',
      joinUrl: 'https://meet.google.com/abc-defg-hij',
      agenda: 'Walk the Q3 roadmap, confirm billing milestones, align on hiring for the platform team.',
      url: `${APP}/meetings`,
    }),
  },
  {
    name: 'meeting-reminder',
    label: 'Meeting reminder',
    content: templates.meetingReminder({
      title: 'Q3 Roadmap Review',
      whenLabel: 'Today · 3:00 PM (PKT)',
      startsInLabel: 'in 15 minutes',
      joinUrl: 'https://meet.google.com/abc-defg-hij',
      url: `${APP}/meetings`,
    }),
  },
  {
    name: 'invoice-issued',
    label: 'Invoice issued',
    content: templates.invoiceIssued({
      recipientName: 'Saad Ajmal',
      invoiceNumber: 'INV-2026-0042',
      clientName: 'Northwind Trading Co.',
      amountLabel: '$12,500.00',
      dueDate: 'Jul 2, 2026',
      url: `${APP}/finance`,
    }),
  },
  {
    name: 'invoice-paid',
    label: 'Invoice paid',
    content: templates.invoicePaid({
      invoiceNumber: 'INV-2026-0039',
      clientName: 'Acme Robotics',
      amountLabel: '$8,200.00',
      paidDate: 'Jun 18, 2026',
      url: `${APP}/finance`,
    }),
  },
  {
    name: 'invoice-overdue',
    label: 'Invoice overdue',
    content: templates.invoiceOverdue({
      invoiceNumber: 'INV-2026-0031',
      clientName: 'Globex Media',
      amountLabel: '$4,750.00',
      dueDate: 'Jun 4, 2026',
      daysOverdueLabel: '14 days',
      url: `${APP}/finance`,
    }),
  },
  {
    name: 'project-status',
    label: 'Project status changed',
    content: templates.projectStatusChanged({
      projectName: 'Billing Platform',
      fromStatus: 'In Development',
      toStatus: 'Active',
      byName: 'Saad Ajmal',
      url: `${APP}/projects/p_billing`,
    }),
  },
  {
    name: 'client-added',
    label: 'New client',
    content: templates.clientAdded({
      recipientName: 'Usman Khalid',
      clientName: 'Northwind Trading Co.',
      addedByName: 'Saad Ajmal',
      industry: 'Logistics',
      url: `${APP}/clients/c_northwind`,
    }),
  },
  {
    name: 'leave-request',
    label: 'Time off (HR)',
    content: templates.leaveRequest({
      recipientName: 'Saad Ajmal',
      employeeName: 'Scott Meyer',
      leaveType: 'Vacation',
      rangeLabel: 'Jun 23 – Jun 27, 2026 (5 days)',
      status: 'SUBMITTED',
      url: `${APP}/hr`,
    }),
  },
  {
    name: 'weekly-digest',
    label: 'Weekly digest',
    content: templates.weeklyDigest({
      recipientName: 'Usman Khalid',
      weekLabel: 'Jun 9 – Jun 15',
      stats: [
        { label: 'Tasks completed', value: '37' },
        { label: 'Tasks created', value: '41' },
        { label: 'Meetings', value: '12' },
        { label: 'Revenue booked', value: '$20,700' },
      ],
      highlights: [
        'Billing Platform moved to Active.',
        'Acme Robotics paid invoice INV-2026-0039.',
        '3 new tasks are overdue across Compliance.',
      ],
      url: `${APP}/dashboard`,
    }),
  },
  {
    name: 'alert',
    label: 'Generic alert',
    content: templates.alert({
      title: 'Two admin accounts were created',
      message:
        'usman@devfathom.com and scott@devfathom.com were added with the Admin role. If this wasn’t you, rotate credentials immediately.',
      tone: 'warning',
      kicker: 'Security',
      details: [
        { label: 'When', value: 'Jun 18, 2026 · 1:30 AM' },
        { label: 'By', value: 'Saad Ajmal' },
      ],
      ctaLabel: 'Review team',
      ctaUrl: `${APP}/team`,
    }),
  },
];

async function main() {
  const sendFlagIdx = process.argv.indexOf('--send');
  const sendTo = sendFlagIdx !== -1 ? process.argv[sendFlagIdx + 1] : undefined;

  const outDir = join(process.cwd(), '.preview', 'emails');
  mkdirSync(outDir, { recursive: true });

  const links: string[] = [];
  for (const item of GALLERY) {
    writeFileSync(join(outDir, `${item.name}.html`), item.content.html, 'utf8');
    links.push(
      `<li style="margin:6px 0;font-family:system-ui;"><a href="./${item.name}.html">${item.label}</a> <code style="color:#6e7570;">${item.content.subject}</code></li>`
    );
  }
  writeFileSync(
    join(outDir, 'index.html'),
    `<!doctype html><meta charset=utf-8><title>DevFathom email gallery</title><body style="background:#f7f5ef;padding:40px;"><h1 style="font-family:system-ui;color:#0c2e2c;">DevFathom email gallery — ${GALLERY.length} templates</h1><ul>${links.join('')}</ul></body>`,
    'utf8'
  );
  console.log(`✅ Rendered ${GALLERY.length} templates → ${outDir}/index.html`);

  if (!sendTo) {
    console.log('ℹ️  Pass --send <email> to also deliver each sample.');
    return;
  }

  console.log(`\n📮 Sending ${GALLERY.length} samples to ${sendTo} …`);
  let ok = 0;
  for (const item of GALLERY) {
    try {
      const res = await sendEmail({
        to: { email: sendTo },
        subject: `[DevFathom sample] ${item.content.subject}`,
        html: item.content.html,
        text: item.content.text,
      });
      ok++;
      console.log(`  ✅ ${item.label} — ${res.messageId}`);
    } catch (e) {
      console.error(`  ❌ ${item.label}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\nDone: ${ok}/${GALLERY.length} sent to ${sendTo}.`);
}

main().catch((e) => {
  console.error('❌ Failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
