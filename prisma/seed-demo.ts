/**
 * DevFathom — Demo data ENRICHMENT (additive, idempotent).
 *
 * The canonical `seed.ts` lays the foundation (users, clients, 8 projects,
 * client-project tasks, a handful of invoices/transactions, 5 messages).
 * This script fills in everything the foundation leaves bare so the app
 * actually looks lived-in:
 *
 *   • Tasks for the 4 internal projects (which had boards but no cards)
 *   • A "completed work" history per member (Done-column tasks with back-dated
 *     updatedAt) — this is what powers /team/stats velocity, leaderboards,
 *     cycle time, and the per-member sparkline.
 *   • Task comments + attachments + column default assignees
 *   • Obsidian-style Notes with real Tiptap JSON + cross-note backlinks
 *   • Documents (per client) and ProjectFiles (per project)
 *   • Performance notes (HR)
 *   • Past recurring meetings + per-occurrence MeetingAttendanceLog (powers
 *     meeting attendance / punctuality stats)
 *   • A busy chat: messages + threads + reactions in every channel, plus DMs
 *   • Finance through June 2026 (invoices + income/expense transactions) so the
 *     revenue chart and P&L look current and healthy
 *   • Time entries, extra activities, notifications, leave requests
 *
 * It does NOT reset the DB and preserves any extra accounts (e.g. the custom
 * admin). Every section is guarded by a count check, so it's safe to re-run.
 *
 *   bunx tsx prisma/seed-demo.ts
 */
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { randomBytes } from 'crypto';
import { hash } from 'bcryptjs';
import 'dotenv/config';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── time helpers ─────────────────────────────────────────────────────────
const now = new Date();
const DAY = 24 * 60 * 60 * 1000;
function daysAgo(n: number, h = 10, m = 0) {
  const d = new Date(now.getTime() - n * DAY);
  d.setHours(h, m, 0, 0);
  return d;
}
function hoursAgo(n: number) {
  return new Date(now.getTime() - n * 60 * 60 * 1000);
}
function minutesAgo(n: number) {
  return new Date(now.getTime() - n * 60 * 1000);
}
function ymd(year: number, month0: number, day: number, h = 12, m = 0) {
  return new Date(year, month0, day, h, m, 0, 0);
}
function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

// Set a server-managed @updatedAt (or other) timestamp via raw SQL, since
// Prisma won't let you write @updatedAt fields through the typed client.
async function setTimestamp(table: string, id: string, field: string, date: Date) {
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "${field}" = $1::timestamptz WHERE "id" = $2`,
    date.toISOString(),
    id
  );
}

// ── tiptap doc builders (for Notes) ──────────────────────────────────────
const txt = (s: string) => ({ type: 'text', text: s });
const bold = (s: string) => ({ type: 'text', marks: [{ type: 'bold' }], text: s });
const link = (id: string, title: string) => ({ type: 'noteLink', attrs: { id, title } });
const h = (level: number, ...inline: any[]) => ({ type: 'heading', attrs: { level }, content: inline });
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline.length ? inline : undefined });
const bullet = (...items: any[][]) => ({
  type: 'bulletList',
  content: items.map((inline) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: inline }],
  })),
});
const ordered = (...items: any[][]) => ({
  type: 'orderedList',
  attrs: { start: 1 },
  content: items.map((inline) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: inline }],
  })),
});
const quote = (...inline: any[]) => ({
  type: 'blockquote',
  content: [{ type: 'paragraph', content: inline }],
});
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });

// replicate src/server/routers/notes.ts helpers exactly
function extractPlainText(node: any, parts: string[] = []): string {
  if (!node || typeof node !== 'object') return parts.join(' ').slice(0, 10000);
  if (typeof node.text === 'string') parts.push(node.text);
  if (Array.isArray(node.content)) node.content.forEach((c: any) => extractPlainText(c, parts));
  return parts.join(' ').slice(0, 10000);
}
function extractLinkedNoteIds(node: any, ids = new Set<string>()): string[] {
  if (!node || typeof node !== 'object') return [...ids];
  if (node.type === 'noteLink' && node.attrs && typeof node.attrs.id === 'string') ids.add(node.attrs.id);
  if (Array.isArray(node.content)) node.content.forEach((c: any) => extractLinkedNoteIds(c, ids));
  return [...ids];
}

async function main() {
  console.log('🌱 DevFathom demo ENRICHMENT starting…\n');

  // ── load existing entities ─────────────────────────────────────────────
  const userList = await prisma.user.findMany();
  const byEmail: Record<string, any> = Object.fromEntries(userList.map((u) => [u.email, u]));
  const alex = byEmail['alex@company.com'];
  const jordan = byEmail['jordan@company.com'];
  const sam = byEmail['sam@company.com'];
  const taylor = byEmail['taylor@company.com'];
  const casey = byEmail['casey@company.com'];
  const riley = byEmail['riley@company.com'];
  const jamie = byEmail['jamie@company.com'];
  const morgan = byEmail['morgan@company.com'];
  const team = [alex, jordan, sam, taylor, casey, riley, jamie, morgan].filter(Boolean);
  // any extra admin accounts (e.g. the custom one) — give them a presence too
  const extras = userList.filter((u) => !team.some((t) => t.id === u.id));

  if (!alex || !sam) {
    console.error('❌ Base seed not detected (alex/sam missing). Run `bun run db:seed` first.');
    process.exit(1);
  }

  const projectList = await prisma.project.findMany({
    include: { boards: { include: { columns: true, labels: true } }, members: true },
  });
  const byProj: Record<string, any> = Object.fromEntries(projectList.map((p) => [p.name, p]));
  const clientList = await prisma.client.findMany();
  const byClient: Record<string, any> = Object.fromEntries(clientList.map((c) => [c.name, c]));

  const colOf = (projName: string, colName: string) => {
    const p = byProj[projName];
    if (!p?.boards?.length) return null;
    return p.boards[0].columns.find((c: any) => c.name === colName) ?? null;
  };
  // Task assignees must be project members (enforced by the
  // task_assignee_project_membership trigger), so enrol each demo assignee in
  // the project before assigning them work there.
  const ensureProjectMember = async (projName: string, userId: string) => {
    const p = byProj[projName];
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: p.id, userId } },
      update: {},
      create: { projectId: p.id, userId, organizationId: p.organizationId },
    });
  };
  const labelOf = (projName: string, labelName: string) => {
    const p = byProj[projName];
    if (!p?.boards?.length) return null;
    return p.boards[0].labels.find((l: any) => l.name === labelName) ?? null;
  };

  const counts = {
    notes: await prisma.note.count(),
    timeEntries: await prisma.timeEntry.count(),
    documents: await prisma.document.count(),
    projectFiles: await prisma.projectFile.count(),
    perfNotes: await prisma.performanceNote.count(),
    attendanceLog: await prisma.meetingAttendanceLog.count(),
    apiTokens: await prisma.apiToken.count(),
    columnDefaults: await prisma.columnDefaultAssignee.count(),
    comments: await prisma.taskComment.count(),
    attachments: await prisma.taskAttachment.count(),
    dms: await prisma.channel.count({ where: { type: 'DM' } }),
    invSentinel: await prisma.invoice.count({ where: { invoiceNumber: 'INV-2026-006' } }),
  };

  // ════════════════════════════════════════════════════════════════════════
  // 1. TASKS FOR INTERNAL PROJECTS (they had empty boards)
  // ════════════════════════════════════════════════════════════════════════
  const internalTasksByProject: Record<
    string,
    Array<{ title: string; desc: string; col: string; pri: any; label: string; due?: Date | null; assignees: any[]; checklist?: { name: string; items: [string, boolean][] } }>
  > = {
    TravelDesk: [
      { title: 'Stripe subscription billing migration', desc: 'Move legacy one-off charges to Stripe Billing with proration and dunning emails.', col: 'In Progress', pri: 'HIGH', label: 'Feature', due: daysAgo(-6), assignees: [alex] },
      { title: 'SEO landing pages for top 10 destinations', desc: 'Programmatic SEO pages with structured data and itinerary previews.', col: 'In Progress', pri: 'MEDIUM', label: 'Enhancement', due: daysAgo(-12), assignees: [jamie] },
      { title: 'Refund flow edge case: partial cancellations', desc: 'Refunds fail when only one leg of a multi-city trip is cancelled.', col: 'To Do', pri: 'HIGH', label: 'Bug', due: daysAgo(-3), assignees: [alex] },
      { title: 'Customer support macros + canned replies', desc: 'Add a macro library to the support inbox to speed up common responses.', col: 'To Do', pri: 'LOW', label: 'Enhancement', assignees: [jamie] },
      { title: 'Abandoned-cart re-engagement emails', desc: 'Trigger a 3-email sequence when a booking is started but not completed.', col: 'Backlog', pri: 'MEDIUM', label: 'Feature', assignees: [jamie] },
      { title: 'Multi-currency display on quotes', desc: 'Show prices in the visitor’s local currency with daily FX rates.', col: 'Backlog', pri: 'LOW', label: 'Feature', assignees: [alex] },
      { title: 'PDF itinerary generator', desc: 'Branded PDF itineraries emailed on booking confirmation.', col: 'Review', pri: 'MEDIUM', label: 'Feature', due: daysAgo(2), assignees: [alex], checklist: { name: 'Itinerary PDF', items: [['Design template', true], ['Wire up booking data', true], ['Brand fonts + logo', true], ['QA across email clients', false]] } },
    ],
    MindMap: [
      { title: 'Canvas pan/zoom performance pass', desc: 'Maintain 60fps with 500+ nodes; virtualize off-screen nodes.', col: 'In Progress', pri: 'HIGH', label: 'Enhancement', due: daysAgo(-4), assignees: [sam] },
      { title: 'AI "expand this idea" node action', desc: 'Right-click a node → generate 3–5 child ideas via the model.', col: 'In Progress', pri: 'HIGH', label: 'Feature', due: daysAgo(-8), assignees: [sam] },
      { title: 'Real-time multiplayer cursors', desc: 'Show collaborators’ cursors and selections live on the canvas.', col: 'To Do', pri: 'MEDIUM', label: 'Feature', assignees: [sam] },
      { title: 'Node theming + colour palettes', desc: 'Let users theme branches with preset palettes.', col: 'To Do', pri: 'LOW', label: 'Design', assignees: [morgan] },
      { title: 'Export to Markdown / OPML', desc: 'One-click export of a map to nested Markdown or OPML.', col: 'Backlog', pri: 'MEDIUM', label: 'Feature', assignees: [sam] },
      { title: 'Onboarding empty-state illustration', desc: 'First-run canvas needs a friendly empty state to guide users.', col: 'Backlog', pri: 'LOW', label: 'Design', assignees: [morgan] },
      { title: 'Keyboard-first navigation', desc: 'Tab/arrow navigation and shortcuts for adding/linking nodes.', col: 'Review', pri: 'MEDIUM', label: 'Enhancement', due: daysAgo(1), assignees: [sam] },
    ],
    ScopeFlow: [
      { title: 'Scope template library', desc: 'Pre-built scope templates by project type (web, mobile, branding).', col: 'In Progress', pri: 'HIGH', label: 'Feature', due: daysAgo(-5), assignees: [casey] },
      { title: 'Client e-sign approval flow', desc: 'Clients approve a scope via a tokenised link with audit trail.', col: 'In Progress', pri: 'HIGH', label: 'Feature', due: daysAgo(-9), assignees: [alex] },
      { title: 'Change-request diffing', desc: 'Visual diff between scope versions so clients see what changed.', col: 'To Do', pri: 'MEDIUM', label: 'Feature', assignees: [sam] },
      { title: 'Stripe metered usage for seats', desc: 'Bill agencies per active seat with monthly metering.', col: 'To Do', pri: 'MEDIUM', label: 'Feature', assignees: [alex] },
      { title: 'Resend transactional email setup', desc: 'Wire up Resend for invites, approvals, and reminders.', col: 'Backlog', pri: 'LOW', label: 'Enhancement', assignees: [sam] },
      { title: 'Pricing page + plan comparison', desc: 'Public pricing page with feature matrix and FAQ.', col: 'Backlog', pri: 'LOW', label: 'Documentation', assignees: [casey] },
      { title: 'Audit log for scope edits', desc: 'Immutable log of who changed what and when.', col: 'Review', pri: 'MEDIUM', label: 'Feature', due: daysAgo(3), assignees: [alex], checklist: { name: 'Audit log', items: [['Schema + triggers', true], ['API surface', true], ['UI timeline', false]] } },
    ],
    WellMind: [
      { title: 'Daily mood check-in flow', desc: 'Lightweight 3-tap mood logging with optional note.', col: 'In Progress', pri: 'HIGH', label: 'Feature', due: daysAgo(-7), assignees: [taylor] },
      { title: 'Guided breathing exercise (haptics)', desc: 'Animated breathing guide with haptic pacing on iOS/Android.', col: 'In Progress', pri: 'MEDIUM', label: 'Feature', due: daysAgo(-11), assignees: [taylor] },
      { title: 'Mood trend insights (on-device)', desc: 'TensorFlow Lite model surfaces weekly mood patterns privately.', col: 'To Do', pri: 'HIGH', label: 'Feature', assignees: [casey] },
      { title: 'Streaks + gentle reminders', desc: 'Non-punitive streaks and customizable reminder times.', col: 'To Do', pri: 'LOW', label: 'Enhancement', assignees: [taylor] },
      { title: 'Calming colour + motion system', desc: 'Define a soft palette and reduced-motion friendly transitions.', col: 'Backlog', pri: 'MEDIUM', label: 'Design', assignees: [morgan] },
      { title: 'Crisis resources screen', desc: 'Region-aware hotline and resource directory, always reachable.', col: 'Backlog', pri: 'HIGH', label: 'Feature', assignees: [casey] },
      { title: 'Privacy-first analytics review', desc: 'Audit all tracking to guarantee no mood data leaves the device.', col: 'Review', pri: 'URGENT', label: 'Bug', due: daysAgo(1), assignees: [taylor] },
    ],
  };

  let internalTaskCount = 0;
  for (const [projName, tasks] of Object.entries(internalTasksByProject)) {
    const backlog = colOf(projName, 'Backlog');
    if (!backlog) continue;
    const existing = await prisma.task.count({ where: { column: { boardId: byProj[projName].boards[0].id } } });
    if (existing > 0) continue; // already has cards — skip
    let order = 0;
    for (const t of tasks) {
      const column = colOf(projName, t.col);
      const label = labelOf(projName, t.label);
      for (const u of t.assignees) await ensureProjectMember(projName, u.id);
      const created = await prisma.task.create({
        data: {
          title: t.title,
          description: t.desc,
          columnId: column.id,
          order: order++,
          priority: t.pri,
          dueDate: t.due ?? null,
          createdById: alex.id,
          createdAt: daysAgo(20 + (order % 10)),
          assignees: { create: t.assignees.map((u: any) => ({ userId: u.id })) },
          labels: label ? { create: [{ labelId: label.id }] } : undefined,
        },
      });
      if (t.checklist) {
        await prisma.taskChecklist.create({
          data: {
            name: t.checklist.name,
            taskId: created.id,
            items: { create: t.checklist.items.map(([text, done], idx) => ({ text, completed: done, order: idx })) },
          },
        });
      }
      internalTaskCount++;
    }
  }
  console.log(`📋 Internal-project tasks: +${internalTaskCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 2. COMPLETED-WORK HISTORY  → powers /team/stats (velocity, leaderboards,
  //    cycle time, sparkline). Done-column tasks with back-dated updatedAt.
  // ════════════════════════════════════════════════════════════════════════
  const HISTORY_TAG = 'auto-logged completed work';
  const historyExisting = await prisma.task.count({ where: { description: { contains: HISTORY_TAG } } });
  let historyCount = 0;
  if (historyExisting === 0) {
    // each member → a primary project + a pool of believable finished items
    const memberWork: Array<{ user: any; project: string; titles: string[] }> = [
      { user: alex, project: 'Hearthly Platform', titles: ['Architected events service', 'Reviewed moderation pipeline RFC', 'Cut v2.3 release', 'Paired on auth refactor', 'Closed out infra migration', 'Wrote incident post-mortem', 'Approved scope for groups feature'] },
      { user: sam, project: 'Meridian Finance Platform', titles: ['Shipped portfolio rebalancing API', 'Hardened wallet signing', 'Added rate-limit middleware', 'Optimised positions query (3x)', 'Fixed decimal rounding in P&L', 'Wrote contract integration tests', 'Upgraded ethers to v6'] },
      { user: taylor, project: 'Bluepeak App', titles: ['Released iOS build 142', 'Cut booking flow to 3 steps', 'Added Apple Pay sheet', 'Fixed HEIC upload crash', 'Reduced cold start by 40%', 'Wired push notifications', 'Migrated to Expo SDK'] },
      { user: casey, project: 'Hearthly Platform', titles: ['Ran 6 user interviews', 'Shipped onboarding tour', 'Synthesised research into specs', 'Defined groups MVP scope', 'Built activation funnel dashboard', 'Wrote PRD for marketplace', 'Closed beta feedback loop'] },
      { user: riley, project: 'Meridian Finance Platform', titles: ['Automated regression suite', 'Verified XSS fix', 'Wrote BDD specs for trades', 'Triaged 22 audit findings', 'Signed off beta release', 'Added Cypress smoke tests', 'Caught race in order book'] },
      { user: morgan, project: 'Bluepeak App', titles: ['Delivered booking flow redesign', 'Built component library v2', 'Polished empty states', 'Shipped dark-mode pass', 'Designed provider profiles', 'Iconography refresh', 'Motion spec for transitions'] },
      { user: jamie, project: 'TravelDesk', titles: ['Launched spring campaign', 'Published 8 SEO articles', 'A/B tested landing hero', 'Set up lifecycle emails', 'Refreshed brand social kit', 'Reported Q1 funnel metrics', 'Booked 3 partnerships'] },
      { user: jordan, project: 'ScopeFlow', titles: ['Closed 2 agency pilots', 'Drafted pricing tiers', 'Ran 9 discovery calls', 'Wrote sales playbook', 'Built ROI calculator', 'Negotiated renewal', 'Shipped demo environment'] },
    ];
    // give the extra admin(s) a little history too
    for (const ex of extras) memberWork.push({ user: ex, project: 'ScopeFlow', titles: ['Reviewed roadmap', 'Approved hiring plan', 'Audited security posture'] });

    // distribution of "doneAt" offsets (days ago): mix of this week / last week / month
    const offsets = [1, 2, 4, 6, 9, 12, 18, 24];
    for (const mw of memberWork) {
      const done = colOf(mw.project, 'Done');
      if (!done) continue;
      const n = Math.min(mw.titles.length, 7);
      await ensureProjectMember(mw.project, mw.user.id);
      for (let i = 0; i < n; i++) {
        const doneDaysAgo = offsets[i % offsets.length] + (i < 2 ? 0 : 1);
        const doneAt = daysAgo(doneDaysAgo, 11 + (i % 6), (i * 13) % 60);
        const cycleDays = 2 + ((i * 5) % 14); // 2–16 days to complete
        const createdAt = new Date(doneAt.getTime() - cycleDays * DAY);
        const task = await prisma.task.create({
          data: {
            title: mw.titles[i],
            description: `${HISTORY_TAG} — ${mw.titles[i]}.`,
            columnId: done.id,
            order: 100 + i,
            priority: pick(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH'], i),
            createdById: mw.user.id,
            createdAt,
            assignees: { create: [{ userId: mw.user.id }] },
          },
        });
        // back-date the @updatedAt so the stats queries see it as "completed then"
        await setTimestamp('tasks', task.id, 'updatedAt', doneAt);
        historyCount++;
      }
    }
  }
  console.log(`✅ Completed-work history: +${historyCount} Done tasks (back-dated)`);

  // ════════════════════════════════════════════════════════════════════════
  // 3. TASK COMMENTS (+ a few threaded) — recent ones power commentsThisWeek
  // ════════════════════════════════════════════════════════════════════════
  let commentCount = 0;
  if (counts.comments === 0) {
    // comment on active (non-Done) tasks across all projects
    const activeTasks = await prisma.task.findMany({
      where: { column: { name: { not: 'Done' } }, NOT: { description: { contains: HISTORY_TAG } } },
      include: { assignees: true, column: { include: { board: true } } },
      take: 80,
    });
    const commentTemplates: Array<(name: string) => string> = [
      () => 'Picking this up now — should have a draft by EOD.',
      () => 'Blocked on the API contract, pinged the backend thread.',
      () => 'Pushed a first pass, would love a quick review 🙏',
      () => 'Tested on staging, looks good. Moving to review.',
      () => 'Can we clarify the acceptance criteria here?',
      () => 'Nice work — left two small comments on the PR.',
      () => 'Reproduced the bug, root cause is a stale cache key.',
      () => 'Bumping priority, client asked about this on the sync.',
      () => 'Added a checklist so we don’t miss the edge cases.',
      () => 'Shipped 🚀 Closing once QA signs off.',
    ];
    for (let i = 0; i < activeTasks.length; i++) {
      const t = activeTasks[i];
      const memberIds = await prisma.projectMember.findMany({
        where: { projectId: t.column.board.projectId },
        select: { userId: true },
      });
      const pool = (memberIds.length ? memberIds.map((m) => m.userId) : team.map((u) => u.id));
      const numComments = 1 + (i % 3); // 1–3 comments
      let parentId: string | null = null;
      for (let c = 0; c < numComments; c++) {
        const authorId = pick(pool, i + c);
        const createdAt = c === 0 ? daysAgo(2 + (i % 8), 14, (i * 7) % 60) : minutesAgo(30 + c * 45 + i);
        const comment: { id: string } = await prisma.taskComment.create({
          data: {
            content: pick(commentTemplates, i + c * 3)(''),
            taskId: t.id,
            userId: authorId,
            parentId: c > 0 && i % 4 === 0 ? parentId : null, // occasional thread
            createdAt,
          },
        });
        if (c === 0) parentId = comment.id;
        commentCount++;
      }
    }
  }
  console.log(`💬 Task comments: +${commentCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 4. TASK ATTACHMENTS (badge counts on cards)
  // ════════════════════════════════════════════════════════════════════════
  let attachCount = 0;
  if (counts.attachments === 0) {
    const designOrFeatureTasks = await prisma.task.findMany({
      where: { column: { name: { not: 'Done' } }, NOT: { description: { contains: HISTORY_TAG } } },
      take: 40,
    });
    const files = [
      { name: 'spec.pdf', url: 'https://files.devfathom.com/docs/spec-v2.pdf', type: 'application/pdf', size: 482_000 },
      { name: 'mockups.fig', url: 'https://www.figma.com/file/demo/mockups', type: 'application/figma', size: 2_840_000 },
      { name: 'wireframes.png', url: 'https://files.devfathom.com/img/wireframes.png', type: 'image/png', size: 1_120_000 },
      { name: 'api-contract.md', url: 'https://files.devfathom.com/docs/api-contract.md', type: 'text/markdown', size: 24_500 },
      { name: 'flow-diagram.svg', url: 'https://files.devfathom.com/img/flow.svg', type: 'image/svg+xml', size: 88_000 },
    ];
    for (let i = 0; i < designOrFeatureTasks.length; i += 2) {
      const f = pick(files, i);
      await prisma.taskAttachment.create({
        data: { name: f.name, url: f.url, type: f.type, size: f.size, taskId: designOrFeatureTasks[i].id, createdAt: daysAgo(3 + (i % 10)) },
      });
      attachCount++;
    }
  }
  console.log(`📎 Task attachments: +${attachCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 5. COLUMN DEFAULT ASSIGNEES (auto-assign on column entry)
  // ════════════════════════════════════════════════════════════════════════
  let colDefCount = 0;
  if (counts.columnDefaults === 0) {
    for (const p of projectList) {
      const board = p.boards?.[0];
      if (!board) continue;
      const review = board.columns.find((c: any) => c.name === 'Review');
      if (review && riley) {
        await prisma.columnDefaultAssignee.create({ data: { columnId: review.id, userId: riley.id } }).catch(() => {});
        colDefCount++;
      }
    }
  }
  console.log(`👥 Column default assignees: +${colDefCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 6. NOTES (Tiptap JSON) + backlinks (NoteLink) + shares
  // ════════════════════════════════════════════════════════════════════════
  let noteCount = 0;
  let linkCount = 0;
  if (counts.notes === 0) {
    // pass 1: declare notes (content built in pass 2 once all ids exist)
    type NoteSpec = {
      key: string;
      title: string;
      author: any;
      visibility: 'PRIVATE' | 'SHARED' | 'TEAM';
      project?: string;
      client?: string;
      shareWith?: Array<{ user: any; permission: 'VIEW' | 'EDIT' }>;
      build: (L: (key: string, title: string) => any) => any; // returns doc
      createdDaysAgo: number;
    };
    const specs: NoteSpec[] = [
      {
        key: 'wiki-home', title: '📌 DevFathom — Team Wiki Home', author: alex, visibility: 'TEAM', createdDaysAgo: 40,
        build: (L) => doc(
          h(1, txt('DevFathom Team Wiki')),
          para(txt('Welcome! Start here. This wiki is the single source of truth for how we work.')),
          h(2, txt('Start here')),
          bullet(
            [L('wiki-onboarding', 'Onboarding Guide')],
            [L('eng-handbook', 'Engineering Handbook')],
            [L('design-principles', 'Design Principles')],
            [L('client-playbook', 'Client Engagement Playbook')],
          ),
          h(2, txt('Active projects')),
          bullet(
            [L('northwind-architecture', 'Northwind — Architecture Overview')],
            [L('meridian-security', 'Meridian — Security Notes')],
          ),
          quote(txt('If it isn’t written down, it didn’t happen. Link liberally with [[ ]].')),
        ),
      },
      {
        key: 'wiki-onboarding', title: 'Onboarding Guide', author: casey, visibility: 'TEAM', createdDaysAgo: 38,
        build: (L) => doc(
          h(1, txt('Onboarding Guide')),
          para(txt('Your first week at DevFathom, step by step.')),
          ordered(
            [txt('Get accounts: email, GitHub, Figma, Slack.')],
            [txt('Read the '), L('eng-handbook', 'Engineering Handbook'), txt(' and '), L('design-principles', 'Design Principles'), txt('.')],
            [txt('Pick a "good first issue" from your team board.')],
            [txt('Pair with your onboarding buddy on a real PR.')],
          ),
          h(2, txt('Environments')),
          bullet([txt('Local: Bun + Postgres')], [txt('Staging: auto-deploy from main')], [txt('Prod: dev-fathom-hub.vercel.app')]),
        ),
      },
      {
        key: 'eng-handbook', title: 'Engineering Handbook', author: sam, visibility: 'TEAM', createdDaysAgo: 35,
        build: (L) => doc(
          h(1, txt('Engineering Handbook')),
          h(2, txt('Stack')),
          para(txt('Next.js (App Router), tRPC, Prisma 7, Postgres, NextAuth v5, Bun.')),
          h(2, txt('Conventions')),
          bullet(
            [txt('Trunk-based; small PRs; squash merge.')],
            [txt('Every PR gets one review. QA signs off in '), txt('Review')],
            [txt('Write tests for bug fixes (regression first).')],
          ),
          h(2, txt('Related')),
          para(txt('See '), L('northwind-architecture', 'Northwind — Architecture Overview'), txt(' for a real-world example.')),
        ),
      },
      {
        key: 'design-principles', title: 'Design Principles', author: morgan, visibility: 'TEAM', createdDaysAgo: 33,
        build: () => doc(
          h(1, txt('Design Principles')),
          para(bold('No decoration.'), txt(' Every element earns its place. Abyss palette, brass accent, IBM Plex + Oxanium.')),
          bullet(
            [txt('Clarity over cleverness.')],
            [txt('Motion communicates, never distracts (respect reduced-motion).')],
            [txt('Accessible by default — 4.5:1 contrast minimum.')],
          ),
        ),
      },
      {
        key: 'client-playbook', title: 'Client Engagement Playbook', author: jordan, visibility: 'TEAM', createdDaysAgo: 30,
        build: (L) => doc(
          h(1, txt('Client Engagement Playbook')),
          para(txt('How we run client relationships from kickoff to renewal.')),
          ordered(
            [txt('Discovery + scope (use ScopeFlow templates).')],
            [txt('Weekly sync, async status note every Friday.')],
            [txt('Monthly invoice, NET-30.')],
          ),
          para(txt('Per-client notes: '), L('northwind-architecture', 'Northwind — Architecture Overview'), txt(', '), L('meridian-security', 'Meridian — Security Notes'), txt('.')),
        ),
      },
      {
        key: 'northwind-architecture', title: 'Northwind — Architecture Overview', author: alex, visibility: 'TEAM', project: 'Northwind Delivery Platform', client: 'Northwind Logistics', createdDaysAgo: 28,
        build: (L) => doc(
          h(1, txt('Northwind Delivery Platform — Architecture')),
          para(txt('Real-time delivery logistics. Web + React Native, Node API, Postgres, Redis, Google Maps.')),
          h(2, txt('Key components')),
          bullet(
            [txt('WebSocket gateway for live driver GPS.')],
            [txt('Redis for hot driver-location cache.')],
            [txt('Route optimisation worker (queue-based).')],
          ),
          h(2, txt('Decisions')),
          quote(txt('We cache locations in Redis with a 5s TTL; Postgres is the source of truth on delivery completion.')),
          para(txt('Security review tracked in '), L('meridian-security', 'Meridian — Security Notes'), txt(' (shared patterns).')),
        ),
      },
      {
        key: 'meridian-security', title: 'Meridian — Security Notes', author: sam, visibility: 'SHARED', project: 'Meridian Finance Platform', client: 'Meridian Finance', createdDaysAgo: 26,
        shareWith: [{ user: alex, permission: 'EDIT' }, { user: riley, permission: 'EDIT' }, { user: jordan, permission: 'VIEW' }],
        build: () => doc(
          h(1, txt('Meridian — Security Notes')),
          para(bold('Confidential.'), txt(' Findings from the third-party audit and our remediation.')),
          bullet(
            [txt('XSS in portfolio name input — FIXED (sanitise + CSP).')],
            [txt('Wallet signing moved server-side behind a signer service.')],
            [txt('Rate limiting on all trade endpoints.')],
          ),
          h(2, txt('Open items')),
          bullet([txt('Pen-test re-run before public launch.')], [txt('Key rotation runbook.')]),
        ),
      },
      {
        key: 'standup-notes', title: 'Standup Notes — Engineering', author: sam, visibility: 'SHARED', createdDaysAgo: 6,
        shareWith: [{ user: alex, permission: 'EDIT' }, { user: taylor, permission: 'EDIT' }, { user: riley, permission: 'VIEW' }],
        build: (L) => doc(
          h(1, txt('Engineering Standup — Running Notes')),
          para(bold('Mon'), txt(': Meridian rebalancing API merged. Bluepeak cold-start work ongoing.')),
          para(bold('Tue'), txt(': HEIC upload crash fixed (Bluepeak). Canvas perf pass on MindMap.')),
          para(bold('Wed'), txt(': Reviewing '), L('meridian-security', 'Meridian — Security Notes'), txt(' open items.')),
        ),
      },
      {
        key: 'q3-roadmap', title: 'Q3 2026 Roadmap (draft)', author: casey, visibility: 'SHARED', createdDaysAgo: 9,
        shareWith: [{ user: alex, permission: 'EDIT' }, { user: jordan, permission: 'VIEW' }, { user: morgan, permission: 'VIEW' }],
        build: (L) => doc(
          h(1, txt('Q3 2026 Roadmap')),
          h(2, txt('Themes')),
          bullet([txt('Hearthly groups + events GA')], [txt('Meridian public launch')], [txt('ScopeFlow paid beta')]),
          para(txt('Depends on '), L('meridian-security', 'Meridian — Security Notes'), txt(' sign-off.')),
        ),
      },
      {
        key: 'alex-1on1s', title: '1:1 Notes (private)', author: alex, visibility: 'PRIVATE', createdDaysAgo: 5,
        build: () => doc(
          h(1, txt('1:1 Notes')),
          para(txt('Private running notes for weekly 1:1s. Wins, blockers, growth areas.')),
          bullet([txt('Sam — wants more architecture ownership.')], [txt('Morgan — exploring motion design course.')]),
        ),
      },
      {
        key: 'meeting-retro', title: 'Sprint 14 Retro', author: riley, visibility: 'TEAM', createdDaysAgo: 4,
        build: () => doc(
          h(1, txt('Sprint 14 Retrospective')),
          h(2, txt('What went well')),
          bullet([txt('Faster reviews — median < 4h.')], [txt('Zero prod incidents.')]),
          h(2, txt('What to improve')),
          bullet([txt('Flaky Cypress tests on CI.')], [txt('Scope creep on the events feature.')]),
        ),
      },
      {
        key: 'jamie-content', title: 'Content Calendar — June', author: jamie, visibility: 'SHARED', createdDaysAgo: 7,
        shareWith: [{ user: jordan, permission: 'VIEW' }, { user: casey, permission: 'EDIT' }],
        build: () => doc(
          h(1, txt('Content Calendar — June 2026')),
          bullet([txt('Wk1: "How we cut booking to 3 steps" case study.')], [txt('Wk2: SEO destination pages launch.')], [txt('Wk3: Founder AMA.')]),
        ),
      },
      {
        key: 'morgan-scratch', title: 'Design scratchpad', author: morgan, visibility: 'PRIVATE', createdDaysAgo: 3,
        build: () => doc(h(1, txt('Scratchpad')), para(txt('Ideas: brass micro-interactions, abyss gradient on empty states, chevron loader.'))),
      },
    ];

    // create stubs to obtain ids
    const keyToId: Record<string, string> = {};
    const created: Array<{ spec: NoteSpec; id: string }> = [];
    for (const s of specs) {
      const stub = await prisma.note.create({
        data: {
          title: s.title,
          contentJson: doc(para(txt(s.title))),
          contentText: s.title,
          authorId: s.author.id,
          visibility: s.visibility,
          projectId: s.project ? byProj[s.project]?.id ?? null : null,
          clientId: s.client ? byClient[s.client]?.id ?? null : null,
          createdAt: daysAgo(s.createdDaysAgo),
        },
      });
      keyToId[s.key] = stub.id;
      created.push({ spec: s, id: stub.id });
      if (s.shareWith?.length) {
        await prisma.noteShare.createMany({
          data: s.shareWith.map((sh) => ({ noteId: stub.id, userId: sh.user.id, permission: sh.permission })),
          skipDuplicates: true,
        });
      }
      noteCount++;
    }

    // pass 2: build real content (links resolved), update, create NoteLink rows
    const L = (key: string, title: string) => link(keyToId[key] ?? 'missing', title);
    for (const { spec, id } of created) {
      const content = spec.build(L);
      const text = extractPlainText(content);
      await prisma.note.update({ where: { id }, data: { contentJson: content, contentText: text } });
      await setTimestamp('notes', id, 'updatedAt', daysAgo(Math.max(0, spec.createdDaysAgo - 1)));
      const linkedIds = extractLinkedNoteIds(content).filter((tid) => tid !== id && tid !== 'missing');
      for (const toId of linkedIds) {
        await prisma.noteLink.create({ data: { fromNoteId: id, toNoteId: toId } }).catch(() => {});
        linkCount++;
      }
    }
  }
  console.log(`📝 Notes: +${noteCount} (with ${linkCount} backlinks)`);

  // ════════════════════════════════════════════════════════════════════════
  // 7. DOCUMENTS (per client) + PROJECT FILES (per project)
  // ════════════════════════════════════════════════════════════════════════
  let docCount = 0;
  if (counts.documents === 0) {
    for (const c of clientList) {
      const docs = [
        { name: `${c.name} — MSA.pdf`, url: 'https://files.devfathom.com/legal/msa.pdf', type: 'application/pdf', size: 312_000 },
        { name: `${c.name} — SOW 2026.pdf`, url: 'https://files.devfathom.com/legal/sow-2026.pdf', type: 'application/pdf', size: 188_000 },
        { name: `${c.name} — Brand assets.zip`, url: 'https://files.devfathom.com/brand/assets.zip', type: 'application/zip', size: 14_800_000 },
      ];
      for (let i = 0; i < docs.length; i++) {
        await prisma.document.create({
          data: { ...docs[i], clientId: c.id, uploadedById: pick([alex, jordan], i).id, createdAt: daysAgo(20 + i * 3) },
        });
        docCount++;
      }
    }
  }
  let pfCount = 0;
  if (counts.projectFiles === 0) {
    for (const p of projectList) {
      const lead = p.members.find((m: any) => m.role === 'LEAD')?.userId ?? alex.id;
      const pf = [
        { name: 'Technical spec.pdf', url: 'https://files.devfathom.com/specs/tech-spec.pdf', type: 'application/pdf', size: 420_000 },
        { name: 'Design system.fig', url: 'https://www.figma.com/file/demo/ds', type: 'application/figma', size: 6_200_000 },
        { name: 'ERD.png', url: 'https://files.devfathom.com/img/erd.png', type: 'image/png', size: 540_000 },
      ];
      for (let i = 0; i < pf.length; i++) {
        await prisma.projectFile.create({
          data: { ...pf[i], projectId: p.id, uploadedById: lead, createdAt: daysAgo(15 + i * 4) },
        });
        pfCount++;
      }
    }
  }
  console.log(`📁 Documents: +${docCount}  |  Project files: +${pfCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 8. PERFORMANCE NOTES (HR)
  // ════════════════════════════════════════════════════════════════════════
  let perfCount = 0;
  if (counts.perfNotes === 0) {
    const perf: Array<{ subject: any; author: any; content: string; daysAgo: number }> = [
      { subject: sam, author: alex, content: 'Outstanding quarter. Led the Meridian rebalancing work end-to-end and mentored Taylor on the API layer. Ready for a staff-level scope.', daysAgo: 25 },
      { subject: taylor, author: alex, content: 'Big improvement in mobile performance work — 40% cold-start reduction shipped. Next: deepen testing discipline.', daysAgo: 22 },
      { subject: morgan, author: jordan, content: 'Design system v2 raised the quality bar across every product. Clients have noticed.', daysAgo: 20 },
      { subject: riley, author: alex, content: 'QA coverage and the regression suite are now a genuine safety net. Caught two critical bugs pre-release.', daysAgo: 18 },
      { subject: casey, author: jordan, content: 'Research-driven scoping on Hearthly reduced rework significantly. Strong stakeholder communication.', daysAgo: 14 },
      { subject: jamie, author: jordan, content: 'Spring campaign exceeded lead targets by 18%. SEO pages are starting to compound.', daysAgo: 10 },
    ];
    for (const p of perf) {
      await prisma.performanceNote.create({
        data: { userId: p.subject.id, authorId: p.author.id, content: p.content, createdAt: daysAgo(p.daysAgo) },
      });
      perfCount++;
    }
  }
  console.log(`🧑‍💼 Performance notes: +${perfCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 9. PAST RECURRING MEETINGS + ATTENDANCE LOG (powers attendance stats)
  // ════════════════════════════════════════════════════════════════════════
  let meetingCount = 0;
  let attendanceCount = 0;
  if (counts.attendanceLog === 0) {
    // per-user punctuality profile → makes leaderboards interesting
    const profile = new Map<string, { lateBias: number; attendRate: number }>();
    const setProfile = (u: any, lateBias: number, attendRate: number) => u && profile.set(u.id, { lateBias, attendRate });
    setProfile(alex, 1, 0.95); setProfile(sam, 2, 0.92); setProfile(taylor, 7, 0.85);
    setProfile(casey, 3, 0.9); setProfile(riley, 0, 0.97); setProfile(jamie, 6, 0.8);
    setProfile(jordan, 4, 0.82); setProfile(morgan, 2, 0.88);
    for (const ex of extras) setProfile(ex, 3, 0.85);

    const step = (d: Date, rec: string) => {
      const n = new Date(d);
      if (rec === 'daily') n.setDate(n.getDate() + 1);
      else if (rec === 'weekly') n.setDate(n.getDate() + 7);
      else if (rec === 'biweekly') n.setDate(n.getDate() + 14);
      else if (rec === 'monthly') n.setMonth(n.getMonth() + 1);
      return n;
    };

    const meetings: Array<{ title: string; desc: string; rec: string; startDaysAgo: number; hour: number; min: number; durMin: number; createdBy: any; attendees: any[] }> = [
      { title: 'Daily Standup', desc: 'What you did, what you’re doing, blockers.', rec: 'daily', startDaysAgo: 28, hour: 9, min: 30, durMin: 15, createdBy: alex, attendees: [alex, sam, taylor, casey, riley, morgan, ...extras] },
      { title: 'Weekly Engineering Sync', desc: 'Architecture, code health, and cross-team dependencies.', rec: 'weekly', startDaysAgo: 49, hour: 11, min: 0, durMin: 60, createdBy: sam, attendees: [alex, sam, taylor, riley] },
      { title: 'Sprint Retrospective', desc: 'What went well, what to improve.', rec: 'biweekly', startDaysAgo: 56, hour: 15, min: 0, durMin: 60, createdBy: riley, attendees: [alex, sam, taylor, casey, riley, morgan] },
      { title: 'Client Sync — Northwind Logistics', desc: 'Weekly progress + blockers with Northwind.', rec: 'weekly', startDaysAgo: 42, hour: 16, min: 0, durMin: 30, createdBy: jordan, attendees: [jordan, alex, sam] },
      { title: 'Design Critique', desc: 'Review in-flight design work as a group.', rec: 'weekly', startDaysAgo: 35, hour: 13, min: 0, durMin: 45, createdBy: morgan, attendees: [morgan, casey, alex, taylor] },
      { title: 'Marketing & Growth', desc: 'Pipeline, campaigns, and content review.', rec: 'weekly', startDaysAgo: 35, hour: 10, min: 0, durMin: 30, createdBy: jamie, attendees: [jamie, jordan, casey] },
    ];

    for (const m of meetings) {
      const origStart = daysAgo(m.startDaysAgo, m.hour, m.min);
      const origEnd = new Date(origStart.getTime() + m.durMin * 60 * 1000);
      const meeting = await prisma.meeting.create({
        data: {
          title: m.title,
          description: m.desc,
          startTime: origStart,
          endTime: origEnd,
          location: pick(['Google Meet', 'Zoom', 'Office', 'Figma'], meetingCount),
          recurrence: m.rec,
          createdById: m.createdBy.id,
          createdAt: origStart,
          attendees: { create: m.attendees.filter(Boolean).map((u: any) => ({ userId: u.id })) },
        },
      });
      meetingCount++;

      // walk past occurrences (end <= now) and log attendance
      let occStart = new Date(origStart);
      let guard = 0;
      while (guard++ < 400) {
        const occEnd = new Date(occStart.getTime() + m.durMin * 60 * 1000);
        if (occEnd.getTime() > now.getTime()) break;
        for (const u of m.attendees.filter(Boolean)) {
          const prof = profile.get(u.id) ?? { lateBias: 3, attendRate: 0.85 };
          if (Math.random() > prof.attendRate) continue; // missed this one
          // offset minutes: usually near 0, sometimes late by ~lateBias, occasionally early
          const r = Math.random();
          let offset: number;
          if (r < 0.12) offset = -(1 + Math.floor(Math.random() * 4)); // early
          else if (r < 0.75) offset = Math.floor(Math.random() * Math.min(8, prof.lateBias + 4)); // on time-ish
          else offset = prof.lateBias + Math.floor(Math.random() * 12); // late
          const joinedAt = new Date(occStart.getTime() + offset * 60 * 1000);
          await prisma.meetingAttendanceLog
            .create({ data: { meetingId: meeting.id, userId: u.id, occurrenceStart: new Date(occStart), joinedAt } })
            .then(() => attendanceCount++)
            .catch(() => {});
        }
        occStart = step(occStart, m.rec);
      }
    }
  }
  console.log(`📅 Past meetings: +${meetingCount}  |  Attendance log rows: +${attendanceCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 10. CHAT — fill every channel + threads + reactions + DMs
  // ════════════════════════════════════════════════════════════════════════
  let msgCount = 0;
  let dmCount = 0;
  let reactionCount = 0;
  if (counts.dms === 0) {
    const channels = await prisma.channel.findMany({ include: { members: true } });
    const chByName: Record<string, any> = Object.fromEntries(channels.map((c) => [c.name ?? c.id, c]));

    // make sure extra admins are in the all-hands channels
    for (const name of ['general', 'announcements']) {
      const ch = chByName[name];
      if (!ch) continue;
      for (const ex of extras) {
        await prisma.channelMember.create({ data: { channelId: ch.id, userId: ex.id } }).catch(() => {});
      }
    }

    // helper: insert a list of messages (optionally with a thread + reactions)
    async function postThread(
      channelId: string,
      msgs: Array<{ sender: any; content: string; minsAgo: number; reactions?: Array<{ user: any; emoji: string }>; replies?: Array<{ sender: any; content: string; minsAgo: number }> }>
    ) {
      let last = 0;
      for (const m of msgs) {
        if (!m.sender) continue;
        const root = await prisma.message.create({
          data: { content: m.content, channelId, senderId: m.sender.id, createdAt: minutesAgo(m.minsAgo) },
        });
        msgCount++;
        last = Math.max(last, now.getTime() - m.minsAgo * 60 * 1000);
        for (const rx of m.reactions ?? []) {
          if (!rx.user) continue;
          await prisma.messageReaction.create({ data: { messageId: root.id, userId: rx.user.id, emoji: rx.emoji } }).catch(() => {});
          reactionCount++;
        }
        for (const rep of m.replies ?? []) {
          if (!rep.sender) continue;
          await prisma.message.create({
            data: { content: rep.content, channelId, senderId: rep.sender.id, parentId: root.id, createdAt: minutesAgo(rep.minsAgo) },
          });
          msgCount++;
        }
      }
      // bump channel ordering to the latest message
      if (last) await setTimestamp('channels', channelId, 'updatedAt', new Date(last));
    }

    if (chByName['general']) {
      await postThread(chByName['general'].id, [
        { sender: jordan, content: 'Morning all ☀️ Closed the second ScopeFlow pilot last night — pipeline is looking healthy.', minsAgo: 60 * 26, reactions: [{ user: alex, emoji: '🎉' }, { user: casey, emoji: '🚀' }, { user: sam, emoji: '👏' }] },
        { sender: morgan, content: 'New empty-state illustrations are in Figma if anyone wants a peek.', minsAgo: 60 * 22, reactions: [{ user: casey, emoji: '😍' }, { user: taylor, emoji: '🔥' }], replies: [{ sender: casey, content: 'These are gorgeous, the chevron loader is 👌', minsAgo: 60 * 21 }, { sender: alex, content: 'Ship it.', minsAgo: 60 * 20 }] },
        { sender: riley, content: 'Reminder: please keep flaky Cypress specs out of main — quarantine them instead 🙏', minsAgo: 60 * 8 },
        { sender: alex, content: 'Lunch & learn Friday: Sam on the Meridian signer service. Bring questions.', minsAgo: 60 * 3, reactions: [{ user: taylor, emoji: '👍' }, { user: riley, emoji: '👍' }, { user: morgan, emoji: '👍' }] },
      ]);
    }
    if (chByName['dev-team']) {
      await postThread(chByName['dev-team'].id, [
        { sender: sam, content: 'Rebalancing API is merged. Staging looks stable, watching latency on the positions query.', minsAgo: 60 * 30, reactions: [{ user: taylor, emoji: '🚀' }] },
        { sender: taylor, content: 'HEIC upload crash fixed — root cause was the iOS image picker handing us a non-JPEG. Added a transcode step.', minsAgo: 60 * 9, replies: [{ sender: sam, content: 'Nice. Add a regression test for the transcode path?', minsAgo: 60 * 8 }, { sender: taylor, content: 'Already done ✅', minsAgo: 60 * 7 }] },
        { sender: alex, content: 'Heads up: bumping Prisma to 7.7 on main this afternoon. Pull after ~3pm.', minsAgo: 60 * 2, reactions: [{ user: sam, emoji: '👍' }, { user: taylor, emoji: '👍' }] },
      ]);
    }
    if (chByName['announcements']) {
      await postThread(chByName['announcements'].id, [
        { sender: jordan, content: '📣 We hit a new monthly revenue high in May. Huge thanks to everyone — this is a team result.', minsAgo: 60 * 70, reactions: [{ user: alex, emoji: '🎉' }, { user: sam, emoji: '🎉' }, { user: morgan, emoji: '❤️' }, { user: riley, emoji: '🙌' }, { user: jamie, emoji: '🚀' }] },
        { sender: alex, content: '📣 Meridian public launch is targeted for early July pending the final pen-test. Let’s finish strong.', minsAgo: 60 * 5, reactions: [{ user: sam, emoji: '🔥' }, { user: casey, emoji: '💪' }] },
      ]);
    }

    // project channels (these were empty)
    const projChannelMsgs: Record<string, Array<any>> = {
      'northwind-delivery-platform': [
        { sender: sam, content: 'Live GPS markers are rendering on the customer page 🎉 still tuning the 5s cache TTL.', minsAgo: 60 * 18, reactions: [{ user: alex, emoji: '🔥' }] },
        { sender: morgan, content: 'Analytics dashboard mockups attached to the task — feedback by EOD?', minsAgo: 60 * 6, replies: [{ sender: alex, content: 'Looks great, let’s align the KPI cards with the main dashboard.', minsAgo: 60 * 5 }] },
      ],
      'meridian-finance-platform': [
        { sender: riley, content: 'Verified the XSS fix on the portfolio name field — CSP is doing its job. ✅', minsAgo: 60 * 14, reactions: [{ user: sam, emoji: '🙌' }] },
        { sender: sam, content: 'Multi-chain wallet support spiked; Polygon + Arbitrum look straightforward, will scope this week.', minsAgo: 60 * 4 },
      ],
      'bluepeak-app': [
        { sender: taylor, content: '3-step booking flow is on staging. Conversion in the test cohort is up nicely.', minsAgo: 60 * 20, reactions: [{ user: morgan, emoji: '🚀' }, { user: casey, emoji: '📈' }] },
        { sender: morgan, content: 'Provider profile designs ready for handoff.', minsAgo: 60 * 7 },
      ],
      'hearthly-platform': [
        { sender: casey, content: 'Events RSVP flow is in review. Calendar integration is the last piece.', minsAgo: 60 * 16 },
        { sender: alex, content: 'Moderation dashboard: let’s gate the AI flagging behind a feature flag for launch.', minsAgo: 60 * 3, reactions: [{ user: casey, emoji: '👍' }] },
      ],
    };
    for (const [name, msgs] of Object.entries(projChannelMsgs)) {
      const ch = chByName[name];
      if (ch) await postThread(ch.id, msgs);
    }

    // DMs (type DM, no name, exactly 2 members)
    const dms: Array<{ a: any; b: any; msgs: Array<{ from: 'a' | 'b'; content: string; minsAgo: number }> }> = [
      { a: alex, b: sam, msgs: [{ from: 'a', content: 'Can you own the architecture review for the Meridian launch?', minsAgo: 60 * 12 }, { from: 'b', content: 'Yep, I’ll have a doc ready before the eng sync.', minsAgo: 60 * 11 }, { from: 'a', content: 'Perfect, thank you 🙏', minsAgo: 60 * 11 }] },
      { a: jordan, b: jamie, msgs: [{ from: 'a', content: 'Northwind asked for a case study — can we turn one around this week?', minsAgo: 60 * 9 }, { from: 'b', content: 'On it. I’ll draft and send you a link tomorrow AM.', minsAgo: 60 * 8 }] },
      { a: morgan, b: casey, msgs: [{ from: 'a', content: 'Want to pair on the WellMind calming palette tomorrow?', minsAgo: 60 * 5 }, { from: 'b', content: 'Yes! 2pm work?', minsAgo: 60 * 5 }, { from: 'a', content: '👍', minsAgo: 60 * 4 }] },
      { a: taylor, b: riley, msgs: [{ from: 'a', content: 'Pushed the HEIC fix — can you add it to the regression pass?', minsAgo: 60 * 3 }, { from: 'b', content: 'Added. Will run the mobile suite tonight.', minsAgo: 60 * 2 }] },
    ];
    for (const dm of dms) {
      if (!dm.a || !dm.b) continue;
      const ch = await prisma.channel.create({
        data: { type: 'DM', members: { create: [{ userId: dm.a.id }, { userId: dm.b.id }] } },
      });
      dmCount++;
      let last = 0;
      for (const msg of dm.msgs) {
        const sender = msg.from === 'a' ? dm.a : dm.b;
        await prisma.message.create({ data: { content: msg.content, channelId: ch.id, senderId: sender.id, createdAt: minutesAgo(msg.minsAgo) } });
        msgCount++;
        last = Math.max(last, now.getTime() - msg.minsAgo * 60 * 1000);
      }
      if (last) await setTimestamp('channels', ch.id, 'updatedAt', new Date(last));
    }
  }
  console.log(`💬 Chat: +${msgCount} messages, +${dmCount} DMs, +${reactionCount} reactions`);

  // ════════════════════════════════════════════════════════════════════════
  // 11. FINANCE — extend through June 2026 (invoices + transactions)
  // ════════════════════════════════════════════════════════════════════════
  let invCount = 0;
  let txnCount = 0;
  if (counts.invSentinel === 0) {
    const Y = 2026;
    const invoices: Array<{ number: string; client: string; project: string; total: number; status: any; month: number; day: number; paidMonth?: number; paidDay?: number }> = [
      { number: 'INV-2026-006', client: 'Meridian Finance', project: 'Meridian Finance Platform', total: 22000, status: 'PAID', month: 2, day: 1, paidMonth: 2, paidDay: 12 },
      { number: 'INV-2026-007', client: 'Northwind Logistics', project: 'Northwind Delivery Platform', total: 16000, status: 'PAID', month: 2, day: 5, paidMonth: 2, paidDay: 20 },
      { number: 'INV-2026-008', client: 'Hearthly', project: 'Hearthly Platform', total: 20000, status: 'PAID', month: 3, day: 1, paidMonth: 3, paidDay: 10 },
      { number: 'INV-2026-009', client: 'Bluepeak', project: 'Bluepeak App', total: 14000, status: 'PAID', month: 3, day: 8, paidMonth: 3, paidDay: 22 },
      { number: 'INV-2026-010', client: 'Meridian Finance', project: 'Meridian Finance Platform', total: 25000, status: 'PAID', month: 4, day: 1, paidMonth: 4, paidDay: 8 },
      { number: 'INV-2026-011', client: 'Northwind Logistics', project: 'Northwind Delivery Platform', total: 16000, status: 'PAID', month: 4, day: 5, paidMonth: 4, paidDay: 20 },
      { number: 'INV-2026-012', client: 'Hearthly', project: 'Hearthly Platform', total: 22000, status: 'PAID', month: 5, day: 1, paidMonth: 5, paidDay: 5 },
      { number: 'INV-2026-013', client: 'Bluepeak', project: 'Bluepeak App', total: 15000, status: 'PAID', month: 5, day: 4, paidMonth: 5, paidDay: 12 },
      { number: 'INV-2026-014', client: 'Meridian Finance', project: 'Meridian Finance Platform', total: 28000, status: 'SENT', month: 5, day: 15 },
      { number: 'INV-2026-015', client: 'Northwind Logistics', project: 'Northwind Delivery Platform', total: 16000, status: 'SENT', month: 5, day: 16 },
      { number: 'INV-2026-016', client: 'Hearthly', project: 'Hearthly Platform', total: 21000, status: 'OVERDUE', month: 4, day: 20 },
      { number: 'INV-2026-017', client: 'Bluepeak', project: 'Bluepeak App', total: 15000, status: 'DRAFT', month: 5, day: 18 },
    ];
    for (const inv of invoices) {
      const client = byClient[inv.client];
      const project = byProj[inv.project];
      if (!client) continue;
      const issued = ymd(Y, inv.month, inv.day);
      await prisma.invoice.create({
        data: {
          invoiceNumber: inv.number,
          clientId: client.id,
          projectId: project?.id ?? null,
          items: [
            { description: 'Development Services', quantity: 1, rate: inv.total * 0.7, amount: inv.total * 0.7 },
            { description: 'Design & UX', quantity: 1, rate: inv.total * 0.2, amount: inv.total * 0.2 },
            { description: 'Project Management', quantity: 1, rate: inv.total * 0.1, amount: inv.total * 0.1 },
          ],
          subtotal: inv.total,
          tax: 0,
          total: inv.total,
          currency: 'USD',
          status: inv.status,
          dueDate: new Date(issued.getTime() + 30 * DAY),
          sentAt: inv.status !== 'DRAFT' ? issued : null,
          paidAt: inv.paidMonth != null ? ymd(Y, inv.paidMonth, inv.paidDay!) : null,
          createdAt: issued,
        },
      });
      invCount++;
      // income transaction on payment
      if (inv.status === 'PAID' && inv.paidMonth != null) {
        await prisma.transaction.create({
          data: {
            type: 'INCOME',
            amount: inv.total,
            currency: 'USD',
            description: `Payment for ${inv.number} — ${inv.client}`,
            projectId: project?.id ?? null,
            clientId: client.id,
            date: ymd(Y, inv.paidMonth, inv.paidDay!),
          },
        });
        txnCount++;
      }
    }

    // recurring product revenue (TravelDesk) — smooths the monthly trend
    const travel = byProj['TravelDesk'];
    const retainers = [[0, 6500], [1, 7000], [2, 7500], [3, 8000], [4, 8500], [5, 9000]];
    for (const [month, amt] of retainers) {
      await prisma.transaction.create({
        data: { type: 'INCOME', amount: amt, currency: 'USD', description: 'TravelDesk subscription revenue', projectId: travel?.id ?? null, date: ymd(Y, month, 3) },
      });
      txnCount++;
    }

    // expenses for Apr / May / Jun (existing seed only covered Jan–Mar)
    const monthlyExpenses = (_month: number, salary: number) => [
      { amount: salary, category: 'SALARIES', desc: `Monthly Salaries`, day: 28 },
      { amount: 299, category: 'HOSTING', desc: 'AWS Cloud Services', day: 5 },
      { amount: 20, category: 'SUBSCRIPTIONS', desc: 'Vercel Pro', day: 1 },
      { amount: 45, category: 'SUBSCRIPTIONS', desc: 'Figma Team', day: 15 },
      { amount: 63, category: 'SUBSCRIPTIONS', desc: 'Slack Business+', day: 1 },
      { amount: 72, category: 'SOFTWARE', desc: 'Google Workspace', day: 1 },
      { amount: 89, category: 'SOFTWARE', desc: 'GitHub Team', day: 10 },
      { amount: 300, category: 'MARKETING', desc: 'Google Ads campaign', day: 20 },
      { amount: 180, category: 'UTILITIES', desc: 'Office internet & utilities', day: 8 },
    ];
    for (const [month, salary] of [[3, 8800], [4, 9000], [5, 9000]] as [number, number][]) {
      for (const e of monthlyExpenses(month, salary)) {
        await prisma.transaction.create({
          data: { type: 'EXPENSE', amount: e.amount, currency: 'USD', category: e.category as any, description: e.desc, date: ymd(Y, month, e.day) },
        });
        txnCount++;
      }
    }
    // one-off expenses to enrich the P&L category pie across the year
    const oneOffs: Array<{ amount: number; category: string; desc: string; month: number; day: number }> = [
      { amount: 2200, category: 'HARDWARE', desc: 'MacBook Pro for new hire', month: 4, day: 9 },
      { amount: 750, category: 'TRAVEL', desc: 'Client visit — Northwind (flights + hotel)', month: 3, day: 14 },
      { amount: 640, category: 'TRAVEL', desc: 'Conference — fintech summit', month: 5, day: 10 },
      { amount: 180, category: 'UTILITIES', desc: 'Office internet & utilities', month: 0, day: 8 },
      { amount: 180, category: 'UTILITIES', desc: 'Office internet & utilities', month: 1, day: 8 },
      { amount: 180, category: 'UTILITIES', desc: 'Office internet & utilities', month: 2, day: 8 },
      { amount: 120, category: 'MISCELLANEOUS', desc: 'Team lunch', month: 2, day: 24 },
      { amount: 240, category: 'MISCELLANEOUS', desc: 'Books & courses stipend', month: 4, day: 16 },
      { amount: 1800, category: 'HARDWARE', desc: 'Monitors & peripherals', month: 1, day: 12 },
    ];
    for (const e of oneOffs) {
      await prisma.transaction.create({
        data: { type: 'EXPENSE', amount: e.amount, currency: 'USD', category: e.category as any, description: e.desc, date: ymd(Y, e.month, e.day) },
      });
      txnCount++;
    }
  }
  console.log(`💰 Finance: +${invCount} invoices, +${txnCount} transactions`);

  // ════════════════════════════════════════════════════════════════════════
  // 12. TIME ENTRIES (data completeness; model exists for the REST API)
  // ════════════════════════════════════════════════════════════════════════
  let timeCount = 0;
  if (counts.timeEntries === 0) {
    const memberProjects = await prisma.projectMember.findMany({ select: { userId: true, projectId: true } });
    const byUserProjects = new Map<string, string[]>();
    for (const mp of memberProjects) {
      const arr = byUserProjects.get(mp.userId) ?? [];
      arr.push(mp.projectId);
      byUserProjects.set(mp.userId, arr);
    }
    const descs = ['Feature development', 'Code review & pairing', 'Bug investigation', 'Design work', 'Client meeting + notes', 'Testing & QA', 'Architecture & planning'];
    for (const u of team) {
      const projs = byUserProjects.get(u.id);
      if (!projs?.length) continue;
      // last 15 working-ish days
      for (let d = 0; d < 15; d++) {
        const date = daysAgo(d);
        if (date.getDay() === 0 || date.getDay() === 6) continue; // skip weekends
        if (Math.random() < 0.15) continue; // some gaps
        const projectId = pick(projs, d);
        const hours = [4, 5, 6, 6, 7, 8][Math.floor(Math.random() * 6)];
        await prisma.timeEntry.create({
          data: { userId: u.id, projectId, description: pick(descs, d + u.id.length), hours, date },
        });
        timeCount++;
      }
    }
  }
  console.log(`⏱️  Time entries: +${timeCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 13. ACTIVITIES + NOTIFICATIONS + LEAVE (freshen the feeds)
  // ════════════════════════════════════════════════════════════════════════
  let actCount = 0;
  if ((await prisma.activity.count()) < 20) {
    const acts: Array<{ type: string; message: string; user: any; entityType?: string; hoursAgo: number }> = [
      { type: 'task_completed', message: 'completed "Released iOS build 142"', user: taylor, entityType: 'Task', hoursAgo: 2 },
      { type: 'invoice_paid', message: 'recorded payment for INV-2026-012 (Hearthly, $22,000)', user: jordan, entityType: 'Invoice', hoursAgo: 5 },
      { type: 'note_created', message: 'published "Sprint 14 Retro"', user: riley, entityType: 'Note', hoursAgo: 7 },
      { type: 'comment_added', message: 'commented on "Multi-chain wallet support"', user: sam, entityType: 'Task', hoursAgo: 9 },
      { type: 'task_completed', message: 'completed "Verified the XSS fix"', user: riley, entityType: 'Task', hoursAgo: 12 },
      { type: 'meeting_held', message: 'hosted the Daily Standup', user: alex, entityType: 'Meeting', hoursAgo: 26 },
      { type: 'member_recognized', message: 'left a performance note for Sam', user: alex, entityType: 'User', hoursAgo: 30 },
      { type: 'project_updated', message: 'moved "Audit log for scope edits" to Review', user: alex, entityType: 'Task', hoursAgo: 34 },
      { type: 'invoice_sent', message: 'sent invoice INV-2026-014 to Meridian ($28,000)', user: jordan, entityType: 'Invoice', hoursAgo: 40 },
      { type: 'task_completed', message: 'completed "Delivered booking flow redesign"', user: morgan, entityType: 'Task', hoursAgo: 48 },
    ];
    for (const a of acts) {
      if (!a.user) continue;
      await prisma.activity.create({ data: { type: a.type, message: a.message, userId: a.user.id, entityType: a.entityType ?? null, createdAt: hoursAgo(a.hoursAgo) } });
      actCount++;
    }
  }
  let notifCount = 0;
  if ((await prisma.notification.count()) < 15) {
    const notifs: Array<{ user: any; title: string; message: string; type: string; read: boolean; hoursAgo: number }> = [
      { user: alex, title: 'New comment', message: 'Sam commented on "Multi-chain wallet support"', type: 'comment', read: false, hoursAgo: 1 },
      { user: sam, title: 'Code review requested', message: 'Taylor requested your review on the HEIC fix', type: 'review_request', read: false, hoursAgo: 3 },
      { user: taylor, title: 'Task moved to Review', message: '"Keyboard-first navigation" is ready for QA', type: 'task_update', read: false, hoursAgo: 4 },
      { user: riley, title: 'Assigned by default', message: 'You were auto-assigned to a task entering Review', type: 'task_assigned', read: false, hoursAgo: 6 },
      { user: casey, title: 'Note shared', message: 'Jamie shared "Content Calendar — June" with you', type: 'note_shared', read: true, hoursAgo: 20 },
      { user: morgan, title: 'Mention', message: 'Casey mentioned you in #bluepeak-app', type: 'mention', read: false, hoursAgo: 7 },
      { user: jordan, title: 'Invoice overdue', message: 'INV-2026-016 (Hearthly, $21,000) is overdue', type: 'invoice_overdue', read: false, hoursAgo: 10 },
      { user: jamie, title: 'Campaign milestone', message: 'Spring campaign passed 1,000 signups 🎉', type: 'info', read: true, hoursAgo: 30 },
    ];
    for (const n of notifs) {
      if (!n.user) continue;
      await prisma.notification.create({ data: { userId: n.user.id, title: n.title, message: n.message, type: n.type, isRead: n.read, createdAt: hoursAgo(n.hoursAgo) } });
      notifCount++;
    }
  }
  let leaveCount = 0;
  if ((await prisma.leaveRequest.count()) < 8) {
    const leaves: Array<{ user: any; type: any; start: Date; end: Date; status: any; approver?: any; reason: string }> = [
      { user: morgan, type: 'VACATION', start: ymd(2026, 6, 6), end: ymd(2026, 6, 10), status: 'APPROVED', approver: alex, reason: 'Summer trip' },
      { user: taylor, type: 'REMOTE', start: ymd(2026, 5, 24), end: ymd(2026, 5, 28), status: 'APPROVED', approver: alex, reason: 'WFH — apartment move' },
      { user: sam, type: 'SICK', start: ymd(2026, 5, 11), end: ymd(2026, 5, 11), status: 'APPROVED', approver: alex, reason: 'Migraine' },
      { user: casey, type: 'VACATION', start: ymd(2026, 6, 1), end: ymd(2026, 6, 4), status: 'PENDING', reason: 'Family event' },
      { user: jamie, type: 'REMOTE', start: ymd(2026, 6, 22), end: ymd(2026, 6, 26), status: 'PENDING', reason: 'Conference week' },
    ];
    for (const l of leaves) {
      if (!l.user) continue;
      await prisma.leaveRequest.create({
        data: { userId: l.user.id, type: l.type, startDate: l.start, endDate: l.end, status: l.status, approvedById: l.approver?.id ?? null, reason: l.reason },
      });
      leaveCount++;
    }
  }
  console.log(`🔔 Activities: +${actCount}  |  Notifications: +${notifCount}  |  Leave: +${leaveCount}`);

  // ════════════════════════════════════════════════════════════════════════
  // 14. API TOKENS (df_ prefix, bcrypt-hashed) — print plaintext once
  // ════════════════════════════════════════════════════════════════════════
  const issuedTokens: Array<{ name: string; token: string }> = [];
  if (counts.apiTokens === 0) {
    const tokenSpecs: Array<{ name: string; user: any; scopes: string[]; expiresInDays?: number }> = [
      { name: 'Production Automation', user: alex, scopes: ['*'] },
      { name: 'CI Pipeline (read-only)', user: sam, scopes: ['tasks:read', 'projects:read'] },
      { name: 'Finance Export', user: jordan, scopes: ['finance:read'], expiresInDays: 180 },
    ];
    for (const t of tokenSpecs) {
      if (!t.user) continue;
      const raw = `df_${randomBytes(24).toString('base64url')}`;
      const prefix = raw.slice(0, 12);
      const tokenHash = await hash(raw, 10);
      await prisma.apiToken.create({
        data: {
          name: t.name,
          prefix,
          tokenHash,
          scopes: t.scopes,
          userId: t.user.id,
          lastUsedAt: t.scopes.includes('*') ? hoursAgo(4) : null,
          expiresAt: t.expiresInDays ? new Date(now.getTime() + t.expiresInDays * DAY) : null,
          createdAt: daysAgo(12),
        },
      });
      issuedTokens.push({ name: t.name, token: raw });
    }
  }
  console.log(`🔑 API tokens: +${issuedTokens.length}`);

  // ── summary ──────────────────────────────────────────────────────────────
  console.log('\n✅ Demo enrichment complete!\n');
  if (issuedTokens.length) {
    console.log(`🔑 API tokens: ${issuedTokens.length} issued (full values redacted from logs).`);
    for (const t of issuedTokens) console.log(`   ${t.name}: ${t.token.slice(0, 12)}…`);
    console.log('');
  }
}

main()
  .catch((e) => {
    console.error('❌ Enrichment failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
