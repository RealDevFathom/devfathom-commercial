/**
 * Move QA tickets between columns on the internal "QA Findings" board.
 *
 * STATUS-UPDATE ONLY: the only mutation is task.columnId (moving a card between
 * Backlog/To Do/In Progress/In Review/Done) and the completedAt that move implies
 * (src/lib/task-completion.ts). No rows are created or deleted. This
 * is the single sanctioned write to the shared DB during remediation.
 *
 * Usage:  bun scripts/qa-move-cards.ts "<Target Column>" BUG-ID [BUG-ID ...]
 *   e.g.  bun scripts/qa-move-cards.ts Done FIN-01 FIN-02 PROJ-01
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PROJECT_NAME, BOARD_NAME, COLUMNS } from './qa-lib';
import { completedAtForColumnChange } from '../src/lib/task-completion.js';

const [, , targetColumn, ...bugIds] = process.argv;

if (!targetColumn || !COLUMNS.includes(targetColumn)) {
  console.error(`Target column must be one of: ${COLUMNS.join(' · ')}`);
  process.exit(1);
}
if (bugIds.length === 0) {
  console.error('Provide at least one BUG-ID.');
  process.exit(1);
}

const MAP_PATH = join(import.meta.dir, '.qa-internal-map.json');
const internalMap: Record<string, { taskId: string }> = existsSync(MAP_PATH)
  ? JSON.parse(readFileSync(MAP_PATH, 'utf8'))
  : {};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const project = await prisma.project.findFirst({ where: { name: PROJECT_NAME }, select: { id: true } });
  if (!project) throw new Error(`Project "${PROJECT_NAME}" not found.`);
  const board = await prisma.board.findFirst({
    where: { projectId: project.id, name: BOARD_NAME },
    select: { id: true },
  });
  if (!board) throw new Error(`Board "${BOARD_NAME}" not found.`);

  const columns = await prisma.column.findMany({
    where: { boardId: board.id },
    select: { id: true, name: true },
  });
  const colName = new Map(columns.map((c) => [c.id, c.name]));
  const target = columns.find((c) => c.name === targetColumn);
  if (!target) throw new Error(`Column "${targetColumn}" not found on board.`);

  let moved = 0;
  let failed = 0;
  for (const bugId of bugIds) {
    try {
      let taskId = internalMap[bugId]?.taskId;
      if (!taskId) {
        const t = await prisma.task.findFirst({
          where: { column: { boardId: board.id }, title: { endsWith: `(${bugId})` } },
          select: { id: true },
        });
        taskId = t?.id;
      }
      if (!taskId) {
        failed++;
        console.log(`  ✗ ${bugId}: no task found`);
        continue;
      }
      const before = await prisma.task.findUnique({
        where: { id: taskId },
        select: { columnId: true, column: { select: { name: true } } },
      });
      const fromName = before ? colName.get(before.columnId) ?? '?' : '?';
      await prisma.task.update({
        where: { id: taskId },
        data: {
          columnId: target.id,
          ...completedAtForColumnChange(before?.column.name ?? null, target.name),
        },
      });
      moved++;
      console.log(`  → ${bugId}: ${fromName} → ${targetColumn}`);
    } catch (e: any) {
      failed++;
      console.log(`  ✗ ${bugId}: ${e.message}`);
    }
  }
  console.log(`\nMoved ${moved} card(s) to "${targetColumn}"${failed ? ` · ${failed} failed` : ''}.`);
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
