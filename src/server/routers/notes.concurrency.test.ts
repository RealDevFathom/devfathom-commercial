import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { notify } from '@/lib/notifications';
import { notesRouter } from './notes';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'text', text }] });

describe('notes.update concurrency', () => {
  it('serializes snapshot and update so every accepted edit remains in history', async () => {
    let note = {
      id: 'note_1',
      title: 'Shared plan',
      contentJson: doc('A'),
      contentText: 'A',
      authorId: 'author',
      visibility: 'TEAM',
      projectId: null,
      clientId: null,
      shares: [],
      mentions: [],
    };
    const revisions: Array<{ contentText: string; editedById: string }> = [];
    let transactionTail = Promise.resolve();

    const tx = {
      $queryRaw: vi.fn(async () => [{ id: note.id }]),
      note: {
        findFirst: vi.fn(async () => structuredClone(note)),
        findMany: vi.fn(async () => []),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          note = { ...note, ...data } as typeof note;
          return structuredClone(note);
        }),
      },
      noteRevision: {
        create: vi.fn(async ({ data }: { data: { contentText: string; editedById: string } }) => {
          revisions.push({ contentText: data.contentText, editedById: data.editedById });
        }),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(),
      },
      noteLink: { deleteMany: vi.fn(), createMany: vi.fn() },
      noteMention: { deleteMany: vi.fn(), createMany: vi.fn() },
      user: { findMany: vi.fn(async () => []) },
    };
    const db = {
      ...tx,
      project: { findMany: vi.fn() },
      client: { findMany: vi.fn() },
      // A transaction queue models PostgreSQL's row-lock serialization. Keeping
      // findUnique on the root also makes this test fail against the old router,
      // where both callers read A before entering their transactions.
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
        const run = transactionTail.then(() => callback(tx));
        transactionTail = run.then(
          () => undefined,
          () => undefined
        );
        return run;
      }),
    };
    const caller = (userId: string) =>
      notesRouter.createCaller({
        db,
        session: {
          expires: 'later',
          user: {
            id: userId,
            name: userId,
            role: 'EMPLOYEE',
            department: 'ENGINEERING',
            status: 'ACTIVE',
            organizationId: 'org_1',
          },
        },
        organization: { id: 'org_1' },
        entitlements: { organizationId: 'org_1', enabledModules: [], modules: [], limits: {} },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as never);

    await Promise.all([
      caller('editor_b').update({ id: note.id, contentJson: doc('B') }),
      caller('editor_c').update({ id: note.id, contentJson: doc('C') }),
    ]);
    await caller('editor_c').update({ id: note.id, contentJson: doc('C') });

    expect(note.contentText).toBe('C');
    expect(revisions).toEqual([
      { contentText: 'A', editedById: 'editor_b' },
      { contentText: 'B', editedById: 'editor_c' },
    ]);
    expect(tx.noteRevision.create).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    const lockQuery = tx.$queryRaw.mock.calls[0]?.[0].join('?');
    expect(lockQuery).toContain('"organizationId" = ?');
    expect(lockQuery).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual([note.id, 'org_1']);
    expect(tx.note.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: note.id, organizationId: 'org_1' } })
    );
    expect(tx.note.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: note.id, organizationId: 'org_1' } })
    );
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_1' } })
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.note.findFirst.mock.invocationCallOrder[0]!
    );
    expect(tx.noteRevision.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.note.update.mock.invocationCallOrder[0]!
    );
  });

  it('stops when the tenant-qualified lock finds no note', async () => {
    vi.mocked(notify).mockClear();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      note: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      noteRevision: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
      noteLink: { deleteMany: vi.fn(), createMany: vi.fn() },
      noteMention: { deleteMany: vi.fn(), createMany: vi.fn() },
      user: { findMany: vi.fn() },
    };
    const db = {
      project: { findMany: vi.fn() },
      client: { findMany: vi.fn() },
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const caller = notesRouter.createCaller({
      db,
      session: {
        expires: 'later',
        user: {
          id: 'attacker',
          name: 'Attacker',
          role: 'EMPLOYEE',
          department: 'ENGINEERING',
          status: 'ACTIVE',
          organizationId: 'attacker_org',
        },
      },
      organization: { id: 'attacker_org' },
      entitlements: { organizationId: 'attacker_org', enabledModules: [], modules: [], limits: {} },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as never);

    await expect(caller.update({ id: 'victim_note', title: 'compromised' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(tx.note.findFirst).not.toHaveBeenCalled();
    expect(tx.note.update).not.toHaveBeenCalled();
    expect(tx.noteRevision.create).not.toHaveBeenCalled();
    expect(tx.noteLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.noteMention.deleteMany).not.toHaveBeenCalled();
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });
});
