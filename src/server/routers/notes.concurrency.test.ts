import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router = readFileSync(new URL('./notes.ts', import.meta.url), 'utf8');
const editor = readFileSync(
  new URL('../../app/(app)/notes/notes-content.tsx', import.meta.url),
  'utf8'
);
const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../../prisma/migrations/20261023000502_note_optimistic_concurrency/migration.sql',
    import.meta.url
  ),
  'utf8'
);

describe('note optimistic concurrency contract', () => {
  it('claims the client revision atomically before changing derived note state', () => {
    const update = router.slice(router.indexOf('update: protectedProcedure'));
    const claim = update.indexOf('await tx.note.updateMany');
    const conflict = update.indexOf("code: 'CONFLICT'", claim);
    const backlinkWrite = update.indexOf('await tx.noteLink.deleteMany', claim);

    expect(update).toContain('expectedRevision: z.number().int().nonnegative()');
    expect(update).toContain('where: { id: input.id, revision: input.expectedRevision }');
    expect(update).toContain('revision: { increment: 1 }');
    expect(claim).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(claim);
    expect(backlinkWrite).toBeGreaterThan(conflict);
  });

  it('persists the revision and sends the edit-session revision with a save', () => {
    expect(schema).toContain('revision       Int            @default(0)');
    expect(migration).toContain('ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0');
    expect(editor).toContain('setDraftRevision(note.revision)');
    expect(editor).toContain('expectedRevision: draftRevision');
  });
});
