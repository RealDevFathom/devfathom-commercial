/**
 * @vitest-environment node
 *
 * Regression coverage for note saves against a real, migrated PostgreSQL database.
 * The test deliberately holds the note row from a separate connection, then queues
 * two router updates behind that lock. This proves the router's FOR UPDATE—not a
 * transaction mock—serializes the read/snapshot/write sequence.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { Client } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { notify } from '@/lib/notifications';
import { notesRouter } from './notes';

const databaseUrl = process.env.DATABASE_URL;
const isLoopbackDatabase = (() => {
  if (!databaseUrl) return false;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname);
  } catch {
    return false;
  }
})();
const suite = databaseUrl && isLoopbackDatabase ? describe : describe.skip;
const db =
  databaseUrl && isLoopbackDatabase
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 10 }) })
    : null;

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'text', text }] });

function caller(userId: string, organizationId: string) {
  if (!db) throw new Error('DATABASE_URL is required');
  return notesRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: userId,
        name: userId,
        role: 'EMPLOYEE',
        department: 'ENGINEERING',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId },
    entitlements: { organizationId, enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

async function waitForBlockedSaves(monitor: Client, baseline: number, count: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await monitor.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FOR UPDATE%'
          AND query LIKE '%notes%'`
    );
    if (result.rows[0]!.count >= baseline + count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} note saves to contend on the PostgreSQL lock`);
}

afterAll(async () => {
  await db?.$disconnect();
});

suite('notes.update PostgreSQL concurrency', () => {
  it('preserves both accepted edits across live content and revision history', async () => {
    const sql = new Client({ connectionString: databaseUrl });
    const blocker = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID();
    const organizationId = `notes_concurrency_${suffix}`;
    const departmentId = `department_${suffix}`;
    const authorId = `author_${suffix}`;
    const editorBId = `editor_b_${suffix}`;
    const editorCId = `editor_c_${suffix}`;
    const noteId = `note_${suffix}`;
    const saves: Promise<unknown>[] = [];

    await Promise.all([sql.connect(), blocker.connect()]);
    try {
      await sql.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, 'Notes concurrency test', 'Notes concurrency test', now())`,
        [organizationId]
      );
      await sql.query(
        `INSERT INTO organization_departments
           (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
        [departmentId, organizationId]
      );
      for (const [id, name] of [
        [authorId, 'Author'],
        [editorBId, 'Editor B'],
        [editorCId, 'Editor C'],
      ]) {
        await sql.query(
          `INSERT INTO users
             (id, "organizationId", name, email, department, "updatedAt")
           VALUES ($1, $2, $3, $4, 'ENGINEERING', now())`,
          [id, organizationId, name, `${id}@example.test`]
        );
      }
      await sql.query(
        `INSERT INTO notes
           (id, "organizationId", title, "contentJson", "contentText", "authorId", visibility, "updatedAt")
         VALUES ($1, $2, 'Shared plan', $3::jsonb, 'A', $4, 'TEAM', now())`,
        [noteId, organizationId, JSON.stringify(doc('A')), authorId]
      );

      const baseline = Number(
        (
          await sql.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%FOR UPDATE%' AND query LIKE '%notes%'`
          )
        ).rows[0]!.count
      );
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM notes WHERE id = $1 FOR UPDATE', [noteId]);

      const saveB = caller(editorBId, organizationId).update({
        id: noteId,
        contentJson: doc('B'),
      });
      saves.push(saveB);
      await waitForBlockedSaves(sql, baseline, 1);
      const saveC = caller(editorCId, organizationId).update({
        id: noteId,
        contentJson: doc('C'),
      });
      saves.push(saveC);
      await waitForBlockedSaves(sql, baseline, 2);
      await blocker.query('COMMIT');
      await Promise.all([saveB, saveC]);

      const note = await sql.query<{ contentText: string }>(
        `SELECT "contentText" FROM notes WHERE id = $1`,
        [noteId]
      );
      const revisions = await sql.query<{ contentText: string; editedById: string }>(
        `SELECT "contentText", "editedById" FROM note_revisions
          WHERE "noteId" = $1 ORDER BY "createdAt", id`,
        [noteId]
      );
      expect(note.rows).toEqual([{ contentText: 'C' }]);
      expect(revisions.rows).toEqual([
        { contentText: 'A', editedById: editorBId },
        { contentText: 'B', editedById: editorCId },
      ]);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(saves);
      await sql.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
      await Promise.all([sql.end(), blocker.end()]);
    }
  }, 15_000);

  it('rejects a foreign-tenant note before reading or mutating related data', async () => {
    vi.mocked(notify).mockClear();
    const sql = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID();
    const attackerOrgId = `notes_attacker_${suffix}`;
    const victimOrgId = `notes_victim_${suffix}`;
    const attackerDepartmentId = `attacker_department_${suffix}`;
    const victimDepartmentId = `victim_department_${suffix}`;
    const attackerId = `attacker_${suffix}`;
    const victimId = `victim_${suffix}`;
    const victimNoteId = `victim_note_${suffix}`;
    const victimLinkedNoteId = `victim_linked_note_${suffix}`;

    await sql.connect();
    try {
      for (const [organizationId, departmentId, label] of [
        [attackerOrgId, attackerDepartmentId, 'Attacker'],
        [victimOrgId, victimDepartmentId, 'Victim'],
      ]) {
        await sql.query(
          `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
           VALUES ($1, $1, $2, $2, now())`,
          [organizationId, label]
        );
        await sql.query(
          `INSERT INTO organization_departments
             (id, "organizationId", key, name, "updatedAt")
           VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
          [departmentId, organizationId]
        );
      }
      for (const [id, organizationId, name] of [
        [attackerId, attackerOrgId, 'Attacker'],
        [victimId, victimOrgId, 'Victim'],
      ]) {
        await sql.query(
          `INSERT INTO users
             (id, "organizationId", name, email, department, "updatedAt")
           VALUES ($1, $2, $3, $4, 'ENGINEERING', now())`,
          [id, organizationId, name, `${id}@example.test`]
        );
      }
      for (const [id, title] of [
        [victimNoteId, 'Victim note'],
        [victimLinkedNoteId, 'Victim linked note'],
      ]) {
        await sql.query(
          `INSERT INTO notes
             (id, "organizationId", title, "contentJson", "contentText", "authorId", visibility, "updatedAt")
           VALUES ($1, $2, $3, $4::jsonb, 'original', $5, 'TEAM', now())`,
          [id, victimOrgId, title, JSON.stringify(doc('original')), victimId]
        );
      }

      await expect(
        caller(attackerId, attackerOrgId).update({
          id: victimNoteId,
          title: 'compromised',
          contentJson: doc(`@Victim [[${victimLinkedNoteId}]]`),
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const note = await sql.query<{ title: string; contentText: string }>(
        `SELECT title, "contentText" FROM notes WHERE id = $1`,
        [victimNoteId]
      );
      const links = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM note_links WHERE "fromNoteId" = $1`,
        [victimNoteId]
      );
      const mentions = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM note_mentions WHERE "noteId" = $1`,
        [victimNoteId]
      );
      expect(note.rows).toEqual([{ title: 'Victim note', contentText: 'original' }]);
      expect(links.rows[0]!.count).toBe(0);
      expect(mentions.rows[0]!.count).toBe(0);
      expect(vi.mocked(notify)).not.toHaveBeenCalled();
    } finally {
      await sql.query('DELETE FROM organizations WHERE id = ANY($1)', [
        [attackerOrgId, victimOrgId],
      ]);
      await sql.end();
    }
  });
});
