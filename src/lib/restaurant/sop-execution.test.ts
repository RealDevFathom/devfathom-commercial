/**
 * M7-L4 — SOP execution unit tests.
 * Covers: SCHEDULED→IN_PROGRESS, step completion (idempotent), evidence with sha256,
 * IN_PROGRESS→SUBMITTED/LATE transition based on window, and state-guard errors.
 */
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { startOccurrence, completeStep, attachEvidence, submitOccurrence } from './sop-execution';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'new_id',
      createdAt: new Date(),
      ...data,
    })),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

function makeDb() {
  const db: Record<string, unknown> = {
    restaurantSopOccurrence: model(),
    restaurantSopOccurrenceStep: model(),
    restaurantSopEvidence: model(),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;
const NOW = new Date('2026-08-20T10:00:00.000Z');
const WINDOW_FUTURE = new Date('2026-08-20T18:00:00.000Z');
const WINDOW_PAST = new Date('2026-08-20T09:00:00.000Z');
const OCC_ID = 'occ_1';
const STEP_ID = 'step_1';
const TMPL_STEP_ID = 'tmpl_step_1';

beforeEach(() => {
  db = makeDb();
});

// ── startOccurrence ────────────────────────────────────────────────────────────

describe('startOccurrence', () => {
  it('transitions SCHEDULED → IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SCHEDULED' });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: NOW });

    const result = await startOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });

    expect(result.status).toBe('IN_PROGRESS');
    expect(result.startedAt).toEqual(NOW);
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'IN_PROGRESS', startedAt: NOW }),
      })
    );
  });

  it('transitions REJECTED → IN_PROGRESS (rework path)', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'REJECTED' });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: NOW });

    const result = await startOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('throws NOT_FOUND when occurrence does not exist', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue(null);

    await expect(
      startOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });

  it('throws INVALID_STATE when occurrence is already IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });

    await expect(
      startOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });

  it('throws INVALID_STATE when occurrence is SUBMITTED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    await expect(
      startOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });
});

// ── completeStep ───────────────────────────────────────────────────────────────

describe('completeStep', () => {
  it('marks a step completed on an IN_PROGRESS occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue({
      id: STEP_ID,
      completed: false,
      completedAt: null,
    });
    db.restaurantSopOccurrenceStep.update.mockResolvedValue({ id: STEP_ID, completedAt: NOW });

    const result = await completeStep(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      templateStepId: TMPL_STEP_ID,
      now: NOW,
    });

    expect(result.completed).toBe(true);
    expect(result.completedAt).toEqual(NOW);
  });

  it('is idempotent — returns existing completedAt when already done', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue({
      id: STEP_ID,
      completed: true,
      completedAt: NOW,
    });

    const result = await completeStep(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      templateStepId: TMPL_STEP_ID,
    });

    expect(result.completed).toBe(true);
    expect(db.restaurantSopOccurrenceStep.update).not.toHaveBeenCalled();
  });

  it('throws INVALID_STATE when occurrence is not IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
      })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('throws STEP_NOT_FOUND when step is not on the occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopOccurrenceStep.findUnique.mockResolvedValue(null);

    await expect(
      completeStep(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        templateStepId: TMPL_STEP_ID,
      })
    ).rejects.toMatchObject({ reason: 'STEP_NOT_FOUND' });
  });
});

// ── attachEvidence ─────────────────────────────────────────────────────────────

describe('attachEvidence', () => {
  const contentBytes = Buffer.from('hello evidence');
  // Precomputed sha256 of "hello evidence":
  const expectedHash = createHash('sha256').update(contentBytes).digest('hex');

  it('computes sha256 from contentBytes and creates evidence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopEvidence.create.mockResolvedValue({
      id: 'ev_1',
      contentHash: expectedHash,
      createdAt: NOW,
    });

    const result = await attachEvidence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      contentBytes,
      mimeType: 'image/jpeg',
      sizeBytes: contentBytes.length,
      now: NOW,
    });

    expect(result.contentHash).toBe(expectedHash);
    expect(db.restaurantSopEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contentHash: expectedHash }),
      })
    );
  });

  it('accepts a pre-computed contentHashHex', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'IN_PROGRESS' });
    db.restaurantSopEvidence.create.mockResolvedValue({
      id: 'ev_1',
      contentHash: expectedHash,
      createdAt: NOW,
    });

    const result = await attachEvidence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      contentHashHex: expectedHash,
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });

    expect(result.contentHash).toBe(expectedHash);
  });

  it('throws INVALID when neither contentBytes nor contentHashHex is provided', async () => {
    await expect(
      attachEvidence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        mimeType: 'image/jpeg',
        sizeBytes: 0,
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('throws INVALID when sizeBytes is negative', async () => {
    await expect(
      attachEvidence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        contentHashHex: expectedHash,
        mimeType: 'image/jpeg',
        sizeBytes: -1,
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('throws INVALID_STATE when occurrence is VERIFIED', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'VERIFIED' });

    await expect(
      attachEvidence(db as unknown as ScopedDb, {
        occurrenceId: OCC_ID,
        contentHashHex: expectedHash,
        mimeType: 'image/jpeg',
        sizeBytes: 0,
      })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });
});

// ── submitOccurrence ───────────────────────────────────────────────────────────

describe('submitOccurrence', () => {
  it('transitions IN_PROGRESS → SUBMITTED when within window', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      windowEndsAt: WINDOW_FUTURE,
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, submittedAt: NOW });

    const result = await submitOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });
    expect(result.status).toBe('SUBMITTED');
  });

  it('transitions IN_PROGRESS → LATE when window has closed', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'IN_PROGRESS',
      windowEndsAt: WINDOW_PAST,
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, submittedAt: NOW });

    const result = await submitOccurrence(db as unknown as ScopedDb, {
      occurrenceId: OCC_ID,
      now: NOW,
    });
    expect(result.status).toBe('LATE');
    expect(db.restaurantSopOccurrence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'LATE' }) })
    );
  });

  it('throws INVALID_STATE when occurrence is not IN_PROGRESS', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'SUBMITTED',
      windowEndsAt: WINDOW_FUTURE,
    });

    await expect(
      submitOccurrence(db as unknown as ScopedDb, { occurrenceId: OCC_ID })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });
});
