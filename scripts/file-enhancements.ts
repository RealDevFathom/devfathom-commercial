/**
 * PART 2A — file every /IMPROVEMENTS.md item (IMP-IDs in scripts/enhancements.json)
 * into BOTH trackers, idempotently, and emit /ENHANCEMENTS.md.
 *
 *  (A) GitHub Issues — repo WhatTheStack1/DevFathom-Hub, milestone "Product
 *      Improvements", labels: enhancement + module:* + tier:{quick-win|medium|
 *      big-bet} (+ needs-greenlight for planned big-bets). Idempotent: matched by
 *      (IMP-ID) in the title. Items already DELIVERED via a bug fix are created
 *      then CLOSED with a note so the tracker mirrors reality.
 *  (B) Internal app — Project "QA Remediation — June 2026" › sibling board
 *      "Improvements" › columns Backlog/To Do/In Progress/In Review/Done. One
 *      Task per item (idempotent by IMP-ID in title). implemented → Done,
 *      partial → In Progress, todo/planned → To Do.
 *
 * Run:  bun scripts/file-enhancements.ts
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { completedAtForColumnChange } from '../src/lib/task-completion.js';

const REPO = 'WhatTheStack1/DevFathom-Hub';
const MILESTONE = 'Product Improvements';
const PROJECT_NAME = 'QA Remediation — June 2026';
const BOARD_NAME = 'Improvements';
const COLUMNS = ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'];

type Enh = {
  id: string;
  module: string;
  tier: 'quick-win' | 'medium' | 'big-bet';
  title: string;
  value: string;
  status: 'implemented' | 'partial' | 'todo' | 'planned';
  acceptance: string[];
  related?: string[];
};
const ENH: Enh[] = JSON.parse(readFileSync(join(import.meta.dir, 'enhancements.json'), 'utf8'));

const TIER_LABEL = (t: Enh['tier']) => `tier:${t}`;
const TIER_PRIORITY: Record<Enh['tier'], 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW'> = {
  'big-bet': 'HIGH',
  medium: 'MEDIUM',
  'quick-win': 'LOW',
};
const targetColumnFor = (s: Enh['status']) =>
  s === 'implemented' ? 'Done' : s === 'partial' ? 'In Progress' : 'To Do';

function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e: any) {
    return `__ERR__:${(e.stderr || e.message || '').toString().trim()}`;
  }
}

function issueTitle(e: Enh) {
  return `[${e.tier}][${e.module}] ${e.title} (${e.id})`;
}
function issueBody(e: Enh) {
  const rel = e.related?.length ? `\n**Delivered via / relates to bug(s):** ${e.related.join(', ')}` : '';
  const statusLine =
    e.status === 'implemented'
      ? '✅ **Implemented** (delivered during QA remediation — see related bug fixes).'
      : e.status === 'partial'
        ? '🟡 **Partially implemented** — core delivered via remediation; remainder below.'
        : e.tier === 'big-bet'
          ? '⛔ **Planned (needs-greenlight)** — heavyweight; do NOT rush into this branch.'
          : '⏳ **To build.**';
  return [
    `**IMP-ID:** ${e.id} · **Tier:** ${e.tier} · **Module:** ${e.module}`,
    '',
    statusLine,
    '',
    `**Value:** ${e.value}`,
    rel,
    '',
    '**Acceptance criteria (BA — what it should do, so QA can verify):**',
    ...e.acceptance.map((a) => `- [ ] ${a}`),
    '',
    `_Source: /IMPROVEMENTS.md. Filed in both trackers; reconciled by ${e.id}._`,
  ].join('\n');
}

function ensureLabel(name: string, color: string, desc: string) {
  gh(['label', 'create', name, '--repo', REPO, '--color', color, '--description', desc, '--force']);
}

async function main() {
  // ── GitHub: milestone + labels ──────────────────────────────────────────
  const existingMs = gh([
    'api', `repos/${REPO}/milestones?state=all&per_page=100`, '--jq', '.[].title',
  ]);
  if (!existingMs.includes(MILESTONE)) {
    gh(['api', `repos/${REPO}/milestones`, '-f', `title=${MILESTONE}`, '-f',
      'description=Product improvement roadmap from /IMPROVEMENTS.md (BA).']);
    console.log(`+ milestone "${MILESTONE}"`);
  }
  ensureLabel('enhancement', 'A2EEEF', 'Product improvement (not a bug)');
  ensureLabel('needs-greenlight', 'D93F0B', 'Heavyweight — requires explicit user authorization');
  ensureLabel('tier:quick-win', '0E8A16', 'Hours–1 day');
  ensureLabel('tier:medium', 'FBCA04', 'Days');
  ensureLabel('tier:big-bet', '5319E7', 'Weeks / cross-cutting');
  for (const m of [...new Set(ENH.map((e) => e.module))]) ensureLabel(`module:${m}`, 'C5DEF5', `Module: ${m}`);

  // Existing enhancement issues (idempotency) by IMP-ID in title.
  const listRaw = gh([
    'issue', 'list', '--repo', REPO, '--milestone', MILESTONE, '--state', 'all',
    '--limit', '300', '--json', 'number,title,state',
  ]);
  const existing: Array<{ number: number; title: string; state: string }> =
    listRaw.startsWith('__ERR__') ? [] : JSON.parse(listRaw);
  const byImp = new Map<string, { number: number; state: string }>();
  for (const it of existing) {
    const m = it.title.match(/\((IMP-[A-Z0-9-]+)\)\s*$/);
    if (m) byImp.set(m[1], { number: it.number, state: it.state });
  }

  const ghMap: Record<string, { number: number | null; url: string | null; status: string }> = {};
  const tmpDir = import.meta.dir;
  let created = 0, refreshed = 0, failed = 0;

  for (const e of ENH) {
    const labels = ['enhancement', `module:${e.module}`, TIER_LABEL(e.tier)];
    if (e.tier === 'big-bet' && e.status === 'planned') labels.push('needs-greenlight');
    const bodyFile = join(tmpDir, `.enh-${e.id}.md`);
    writeFileSync(bodyFile, issueBody(e));

    let number: number | null = null;
    const found = byImp.get(e.id);
    if (found) {
      gh(['issue', 'edit', String(found.number), '--repo', REPO, '--body-file', bodyFile,
        '--add-label', labels.join(',')]);
      number = found.number;
      ghMap[e.id] = { number, url: `https://github.com/${REPO}/issues/${number}`, status: 'Skipped-existing' };
      refreshed++;
    } else {
      const out = gh(['issue', 'create', '--repo', REPO, '--title', issueTitle(e),
        '--body-file', bodyFile, '--label', labels.join(','), '--milestone', MILESTONE]);
      if (out.startsWith('__ERR__')) {
        failed++; ghMap[e.id] = { number: null, url: null, status: `Failed: ${out.slice(8).split('\n')[0]}` };
        console.log(`  ✗ ${e.id}: ${out.slice(8).split('\n')[0]}`); continue;
      }
      const m = out.match(/\/issues\/(\d+)/);
      number = m ? Number(m[1]) : null;
      ghMap[e.id] = { number, url: out, status: 'Created' };
      created++;
    }

    // Reconcile to reality: implemented → close with a note.
    if (number && e.status === 'implemented') {
      const cur = byImp.get(e.id);
      if (!cur || cur.state !== 'CLOSED') {
        gh(['issue', 'close', String(number), '--repo', REPO, '--comment',
          `✅ Delivered during QA remediation${e.related?.length ? ` via ${e.related.join(', ')}` : ''}. Acceptance criteria met; see /FIXES.md.`]);
      }
    }
    console.log(`  ${found ? '=' : '+'} ${e.id} -> #${number}`);
  }

  // ── Internal board ───────────────────────────────────────────────────────
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const intMap: Record<string, { taskId: string; status: string }> = {};
  try {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
    if (!admin) throw new Error('No active ADMIN to own tasks');
    const project = await prisma.project.findFirst({ where: { name: PROJECT_NAME }, select: { id: true } });
    if (!project) throw new Error(`Project "${PROJECT_NAME}" not found`);

    let board = await prisma.board.findFirst({ where: { projectId: project.id, name: BOARD_NAME }, select: { id: true } });
    if (!board) {
      board = await prisma.board.create({ data: { name: BOARD_NAME, description: 'Product improvements from /IMPROVEMENTS.md.', projectId: project.id }, select: { id: true } });
      console.log(`+ board "${BOARD_NAME}"`);
    }
    const colId: Record<string, string> = {};
    for (let i = 0; i < COLUMNS.length; i++) {
      let c = await prisma.column.findFirst({ where: { boardId: board.id, name: COLUMNS[i] }, select: { id: true } });
      if (!c) c = await prisma.column.create({ data: { name: COLUMNS[i], boardId: board.id, order: i }, select: { id: true } });
      colId[COLUMNS[i]] = c.id;
    }

    for (let i = 0; i < ENH.length; i++) {
      const e = ENH[i];
      const title = `${e.title} (${e.id})`;
      const gh0 = ghMap[e.id] || {};
      const desc = `${issueBody(e)}\n\n**GitHub:** ${gh0.url ?? '—'}`;
      const targetName = targetColumnFor(e.status);
      const targetCol = colId[targetName];
      const existingTask = await prisma.task.findFirst({ where: { column: { boardId: board.id }, title: { endsWith: `(${e.id})` } }, select: { id: true, column: { select: { name: true } } } });
      let taskId: string;
      if (existingTask) {
        // select:{id} keeps the RETURNING clause to columns that exist on the
        // SHARED Neon DB. New schema columns (parentId/wipLimit/…) live only in the
        // generated client until the migration is deployed, so returning full rows
        // would 500 with P2022 ColumnNotFound. We only need the id (already known).
        await prisma.task.update({ where: { id: existingTask.id }, data: { title, description: desc, priority: TIER_PRIORITY[e.tier], columnId: targetCol, order: i, ...completedAtForColumnChange(existingTask.column.name, targetName) }, select: { id: true } });
        taskId = existingTask.id;
      } else {
        const t = await prisma.task.create({ data: { title, description: desc, priority: TIER_PRIORITY[e.tier], columnId: targetCol, order: i, createdById: admin.id, ...completedAtForColumnChange(null, targetName) }, select: { id: true } });
        taskId = t.id;
      }
      intMap[e.id] = { taskId, status: targetColumnFor(e.status) };
    }
    console.log(`Internal: ${ENH.length} tasks on "${BOARD_NAME}" board`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  // ── ENHANCEMENTS.md ──────────────────────────────────────────────────────
  const counts = {
    implemented: ENH.filter((e) => e.status === 'implemented').length,
    partial: ENH.filter((e) => e.status === 'partial').length,
    todo: ENH.filter((e) => e.status === 'todo').length,
    planned: ENH.filter((e) => e.status === 'planned').length,
  };
  const rows = ENH.map((e) => {
    const g = ghMap[e.id] || {};
    const t = intMap[e.id] || {};
    const ghCell = g.number ? `[#${g.number}](${g.url})` : '—';
    const statusCell = { implemented: 'Implemented', partial: 'Partial', todo: 'To build', planned: 'Planned (greenlight)' }[e.status];
    return `| ${e.id} | ${e.tier} | ${e.module} | ${e.title} | ${ghCell} | \`${t.taskId ?? '—'}\` | ${statusCell} |`;
  });
  const md = `# ENHANCEMENTS.md — Product Improvement roadmap (BA)

Every item in [\`/IMPROVEMENTS.md\`](./IMPROVEMENTS.md) filed in **both trackers** and reconciled by IMP-ID:
- **GitHub** — repo \`${REPO}\`, milestone "${MILESTONE}", labels \`enhancement · module:* · tier:*\` (+ \`needs-greenlight\` for planned big-bets).
- **Internal** — Project "${PROJECT_NAME}" › board "${BOARD_NAME}" (Backlog/To Do/In Progress/In Review/Done).

## Totals (${ENH.length} items)
- **Implemented** (delivered during QA remediation): ${counts.implemented} — issue closed, card → Done.
- **Partial** (core delivered; remainder tracked): ${counts.partial} — card → In Progress.
- **To build** (Quick Win / Medium): ${counts.todo} — card → To Do.
- **Planned (needs-greenlight)** (Big Bets): ${counts.planned} — card → To Do / Backlog, STOP for authorization.

## Big Bets — greenlight required (do NOT rush into this branch)
${ENH.filter((e) => e.tier === 'big-bet').map((e) => `- **${e.id}** — ${e.title}. ${e.value}. Phased plan + acceptance criteria filed; awaiting authorization.`).join('\n')}

## Mapping

| IMP-ID | Tier | Module | Title | GitHub | Internal task id | Status |
|---|---|---|---|---|---|---|
${rows.join('\n')}

_Each item carries acceptance criteria in its issue/task body (the BA's "what it should do") so QA can verify._
`;
  writeFileSync(join(import.meta.dir, '..', 'ENHANCEMENTS.md'), md);
  writeFileSync(join(import.meta.dir, '.enh-gh-map.json'), JSON.stringify(ghMap, null, 2));
  writeFileSync(join(import.meta.dir, '.enh-internal-map.json'), JSON.stringify(intMap, null, 2));
  console.log(`\nGitHub: created=${created} refreshed=${refreshed} failed=${failed} · /ENHANCEMENTS.md written`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL:', e); process.exitCode = 1; });
