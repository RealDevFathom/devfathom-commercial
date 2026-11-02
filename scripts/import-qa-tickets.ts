/**
 * PART B — file every /BUGS.md finding into the internal DevFathom-Hub app as
 *   Project "QA Remediation — June 2026" (INTERNAL)
 *     └─ Board "QA Findings"
 *          └─ Columns: Backlog · To Do · In Progress · In Review · Done
 *               └─ one Task per bug, all in "To Do"
 *
 * SAFE & REVERSIBLE: everything lives under the ONE project, so deleting that
 * project (cascades to boards/columns/tasks/labels) removes the entire import in
 * a single action. Existing rows are never modified or deleted.
 *
 * IDEMPOTENT: re-running creates zero duplicates (find-or-create by name / by
 * BUG-ID in the task title; existing tasks are refreshed in place).
 *
 * Cross-link: each task's References carries the paired GitHub issue # + URL
 * (read from scripts/.qa-gh-map.json) and the shared BUG-ID. Writes
 * scripts/.qa-internal-map.json mapping BUG-ID -> task id.
 *
 * Run:  bun scripts/import-qa-tickets.ts
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import {
  TICKETS,
  ticketTitle,
  renderBody,
  SEV_PRIORITY,
  SEV_LABEL,
  PROJECT_NAME,
  BOARD_NAME,
  COLUMNS,
  TARGET_COLUMN,
  moduleLabels,
} from './qa-lib';
import { completedAtForColumnChange } from '../src/lib/task-completion.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const GH_MAP_PATH = join(import.meta.dir, '.qa-gh-map.json');
const INTERNAL_MAP_PATH = join(import.meta.dir, '.qa-internal-map.json');

const ghMap: Record<string, { number: number | null; url: string | null }> = existsSync(GH_MAP_PATH)
  ? JSON.parse(readFileSync(GH_MAP_PATH, 'utf8'))
  : {};

const SEV_COLORS: Record<string, string> = { high: 'D93F0B', medium: 'FBCA04', low: '0E8A16' };
const TYPE_COLORS: Record<string, string> = {
  security: '5319E7', functional: '1D76DB', data: '006B75', ux: 'C2E0C6', performance: 'D4C5F9',
};

async function main() {
  console.log('Importing QA tickets into the internal app…\n');

  // 0. An ADMIN user to own the tasks (Task.createdById is required). Read-only.
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    select: { id: true, name: true, email: true },
  });
  if (!admin) throw new Error('No active ADMIN user found to own the tasks. Aborting (no rows changed).');
  console.log(`Owner (createdById): ${admin.name} <${admin.email}>`);

  // 1. Project (find-or-create by name).
  let project = await prisma.project.findFirst({ where: { name: PROJECT_NAME } });
  if (project) {
    console.log(`= Project "${PROJECT_NAME}" already exists (${project.id}) — reusing`);
  } else {
    project = await prisma.project.create({
      data: {
        name: PROJECT_NAME,
        description:
          'QA remediation backlog. One ticket per defect in /BUGS.md (53 findings). Mirrored as GitHub Issues in WhatTheStack1/DevFathom-Hub (milestone "QA Remediation"). Delete this project to remove the entire QA import in one action.',
        type: 'INTERNAL',
        status: 'ACTIVE',
      },
    });
    console.log(`+ Created project "${PROJECT_NAME}" (${project.id})`);
  }

  // 2. Board (find-or-create).
  let board = await prisma.board.findFirst({ where: { projectId: project.id, name: BOARD_NAME } });
  if (!board) {
    board = await prisma.board.create({ data: { name: BOARD_NAME, description: 'All /BUGS.md findings.', projectId: project.id } });
    console.log(`+ Created board "${BOARD_NAME}" (${board.id})`);
  } else {
    console.log(`= Board "${BOARD_NAME}" already exists (${board.id})`);
  }

  // 3. Columns (find-or-create, ordered).
  const columnByName: Record<string, string> = {};
  for (let i = 0; i < COLUMNS.length; i++) {
    const name = COLUMNS[i];
    let col = await prisma.column.findFirst({ where: { boardId: board.id, name } });
    if (!col) col = await prisma.column.create({ data: { name, boardId: board.id, order: i } });
    columnByName[name] = col.id;
  }
  const toDoColumnId = columnByName[TARGET_COLUMN];
  console.log(`= Columns: ${COLUMNS.join(' · ')} (target: ${TARGET_COLUMN})`);

  // 4. Board labels (find-or-create) for severity / type / module.
  const labelId: Record<string, string> = {};
  async function ensureLabel(name: string, color: string) {
    let l = await prisma.label.findFirst({ where: { boardId: board!.id, name } });
    if (!l) l = await prisma.label.create({ data: { name, color: `#${color}`, boardId: board!.id } });
    labelId[name] = l.id;
  }
  for (const [s, c] of Object.entries(SEV_COLORS)) await ensureLabel(`severity:${s}`, c);
  for (const tl of [...new Set(TICKETS.map((t) => t.typeLabel))]) await ensureLabel(`type:${tl}`, TYPE_COLORS[tl] || '999999');
  for (const m of moduleLabels()) await ensureLabel(`module:${m}`, 'C5DEF5');

  // 5. Tasks (one per bug, in "To Do"). Idempotent by BUG-ID in title.
  const internalMap: Record<string, { taskId: string; status: string }> = {};
  let created = 0, refreshed = 0, failed = 0;

  for (let i = 0; i < TICKETS.length; i++) {
    const t = TICKETS[i];
    try {
      const title = ticketTitle(t);
      const gh = ghMap[t.id] || {};
      const description = renderBody(t, { githubNumber: gh.number ?? undefined, githubUrl: gh.url ?? undefined });
      const priority = SEV_PRIORITY[t.severity] as 'URGENT' | 'MEDIUM' | 'LOW';

      const existing = await prisma.task.findFirst({
        where: { column: { boardId: board.id }, title: { endsWith: `(${t.id})` } },
        select: { id: true, column: { select: { name: true } } },
      });

      let taskId: string;
      let status: string;
      if (existing) {
        // Re-filing into the target column also reopens a ticket that was Done.
        await prisma.task.update({
          where: { id: existing.id },
          data: {
            title,
            description,
            priority,
            columnId: toDoColumnId,
            order: i,
            ...completedAtForColumnChange(existing.column.name, TARGET_COLUMN),
          },
        });
        taskId = existing.id;
        status = 'Skipped-existing';
        refreshed++;
      } else {
        const task = await prisma.task.create({
          data: { title, description, priority, columnId: toDoColumnId, order: i, createdById: admin.id },
          select: { id: true },
        });
        taskId = task.id;
        status = 'Created';
        created++;
      }

      // Attach severity/type/module labels (idempotent via skipDuplicates).
      const ids = [
        labelId[`severity:${SEV_LABEL[t.severity]}`],
        labelId[`type:${t.typeLabel}`],
        labelId[`module:${t.moduleLabel}`],
      ].filter(Boolean);
      if (ids.length) {
        await prisma.taskLabel.createMany({
          data: ids.map((lid) => ({ taskId, labelId: lid })),
          skipDuplicates: true,
        });
      }

      internalMap[t.id] = { taskId, status };
      console.log(`  ${status === 'Created' ? '+' : '='} ${t.id} -> task ${taskId}`);
    } catch (e: any) {
      failed++;
      internalMap[t.id] = { taskId: '', status: `Failed: ${e.message}` };
      console.log(`  ✗ ${t.id} FAILED: ${e.message}`);
    }
  }

  writeFileSync(INTERNAL_MAP_PATH, JSON.stringify(internalMap, null, 2));

  // 6. Confirm counts.
  const colCount = await prisma.column.count({ where: { boardId: board.id } });
  const taskCount = await prisma.task.count({ where: { column: { boardId: board.id } } });
  const toDoCount = await prisma.task.count({ where: { columnId: toDoColumnId } });
  console.log('\n── Internal import summary ──────────────────────────────');
  console.log(`Project: "${PROJECT_NAME}" (${project.id})`);
  console.log(`Board:   "${BOARD_NAME}" (${board.id})`);
  console.log(`Lists:   ${colCount} (${COLUMNS.join(', ')})`);
  console.log(`Tasks:   ${taskCount} total · ${toDoCount} in "${TARGET_COLUMN}"`);
  console.log(`Result:  created=${created} refreshed=${refreshed} failed=${failed} (of ${TICKETS.length})`);
  console.log(`Map written to ${INTERNAL_MAP_PATH}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('FATAL:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
