import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261118120000_task_label_board_boundary/migration.sql',
  'utf8'
);
const schema = readFileSync('prisma/schema.prisma', 'utf8');
const backupTable = '"task_label_board_repair_backups"';

describe('DEV-190 task label board boundary migration', () => {
  it('runs as one transaction across every tenant', () => {
    expect(migration.trimStart()).toMatch(/^(--[^\n]*\n)*BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`set_config('app.is_platform_admin', 'true', true)`);
  });

  it('backs up every removed link before deleting it, inside the same transaction', () => {
    const backup = migration.indexOf(`INSERT INTO ${backupTable}`);
    const remove = migration.indexOf('DELETE FROM task_labels tl\nUSING');
    expect(backup).toBeGreaterThan(migration.indexOf('BEGIN;'));
    expect(remove).toBeGreaterThan(backup);
    expect(migration.lastIndexOf('COMMIT;')).toBeGreaterThan(remove);
    // Only rows that were copied into the backup are deleted.
    const deleteStatement = migration.slice(remove, migration.indexOf(';', remove));
    expect(deleteStatement).toMatch(/USING "task_label_board_repair_backups" b,/);
    for (const column of ['id', '"organizationId"', '"taskId"', '"labelId"']) {
      expect(deleteStatement).toContain(`b.${column} = tl.${column}`);
    }
    // ...and only while the link is still invalid.
    expect(deleteStatement).toContain('c."boardId" <> l."boardId"');
    // The migration never deletes from any other table.
    expect(migration.match(/^DELETE FROM \S+/gm)).toEqual(['DELETE FROM task_labels']);
    expect(migration).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('keeps the backup table tenant-isolated with forced row-level security', () => {
    expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${backupTable}`);
    expect(migration).toContain(`ALTER TABLE ${backupTable} ENABLE ROW LEVEL SECURITY;`);
    expect(migration).toContain(`ALTER TABLE ${backupTable} FORCE ROW LEVEL SECURITY;`);
    expect(migration).toContain(`CREATE POLICY "tenant_isolation" ON ${backupTable}`);
    expect(schema).toContain('@@map("task_label_board_repair_backups")');
  });

  it('guards every future task-label write and cross-board task move', () => {
    expect(migration).toContain(
      'CREATE TRIGGER task_label_board_guard BEFORE INSERT OR UPDATE ON task_labels'
    );
    expect(migration).toContain(
      'CREATE TRIGGER task_move_label_cleanup AFTER UPDATE OF "columnId" ON tasks'
    );
    expect(migration).toContain('CREATE TRIGGER column_board_ownership_guard');
    expect(migration).toContain('CREATE TRIGGER label_board_ownership_guard');
  });
});
