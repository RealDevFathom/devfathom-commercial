/**
 * M7-L3 — SOP template authoring unit tests. Drives the lifecycle guards against
 * a configurable in-memory db: `sop.templates.max` enforcement, publish
 * immutability (step + transition guards), single-open-draft, no-empty-publish,
 * and latest-published resolution.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  SopTemplateError,
  addStep,
  createDraftVersion,
  createTemplate,
  publishVersion,
  removeStep,
  resolveLatestPublishedVersion,
  retireVersion,
  setTemplateActive,
  updateStep,
} from './sop-templates';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'new_id',
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
    delete: vi.fn().mockResolvedValue({}),
  };
}

function makeDb() {
  const db: Record<string, unknown> = {
    restaurantSopTemplate: model(),
    restaurantSopTemplateVersion: model(),
    restaurantSopTemplateStep: model(),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;
const scoped = () => db as unknown as ScopedDb;

beforeEach(() => {
  db = makeDb();
});

describe('createTemplate — sop.templates.max', () => {
  it('creates a family with an initial DRAFT v1 when under the cap', async () => {
    db.restaurantSopTemplate.count.mockResolvedValue(2);
    await createTemplate(scoped(), { name: '  Opening Checklist  ', category: 'FOH' }, 5);
    expect(db.restaurantSopTemplate.create).toHaveBeenCalledTimes(1);
    const arg = db.restaurantSopTemplate.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.name).toBe('Opening Checklist'); // trimmed
    expect(arg.data.versions).toEqual({ create: { versionNumber: 1, status: 'DRAFT' } });
    expect(arg.data).not.toHaveProperty('organizationId'); // RLS-forced default only
  });

  it('rejects creation at the active-family cap', async () => {
    db.restaurantSopTemplate.count.mockResolvedValue(5);
    await expect(createTemplate(scoped(), { name: 'One More' }, 5)).rejects.toMatchObject({
      reason: 'TEMPLATE_LIMIT_REACHED',
    });
    expect(db.restaurantSopTemplate.create).not.toHaveBeenCalled();
  });

  it('rejects a blank name', async () => {
    await expect(createTemplate(scoped(), { name: '   ' }, 5)).rejects.toBeInstanceOf(
      SopTemplateError
    );
  });
});

describe('setTemplateActive — reactivation re-checks the cap', () => {
  it('rejects reactivating past the cap', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({ id: 't1', isActive: false });
    db.restaurantSopTemplate.count.mockResolvedValue(5);
    await expect(setTemplateActive(scoped(), 't1', true, 5)).rejects.toMatchObject({
      reason: 'TEMPLATE_LIMIT_REACHED',
    });
  });

  it('archiving is always allowed', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({ id: 't1', isActive: true });
    await setTemplateActive(scoped(), 't1', false, 5);
    expect(db.restaurantSopTemplate.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { isActive: false },
    });
    expect(db.restaurantSopTemplate.count).not.toHaveBeenCalled();
  });
});

describe('publish immutability', () => {
  it('addStep is rejected on a PUBLISHED version', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'PUBLISHED',
    });
    await expect(addStep(scoped(), { templateVersionId: 'v1', title: 'x' })).rejects.toMatchObject({
      reason: 'VERSION_NOT_DRAFT',
    });
    expect(db.restaurantSopTemplateStep.create).not.toHaveBeenCalled();
  });

  it('updateStep is rejected on a PUBLISHED version', async () => {
    db.restaurantSopTemplateStep.findUnique.mockResolvedValue({
      id: 's1',
      templateVersionId: 'v1',
    });
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'PUBLISHED',
    });
    await expect(updateStep(scoped(), 's1', { title: 'y' })).rejects.toMatchObject({
      reason: 'VERSION_NOT_DRAFT',
    });
  });

  it('removeStep is rejected on a RETIRED version', async () => {
    db.restaurantSopTemplateStep.findUnique.mockResolvedValue({
      id: 's1',
      templateVersionId: 'v1',
    });
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'RETIRED',
    });
    await expect(removeStep(scoped(), 's1')).rejects.toMatchObject({ reason: 'VERSION_NOT_DRAFT' });
  });

  it('addStep on a DRAFT appends at the next stepOrder', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'DRAFT',
    });
    db.restaurantSopTemplateStep.findFirst.mockResolvedValue({ stepOrder: 3 });
    await addStep(scoped(), {
      templateVersionId: 'v1',
      title: '  Sanitize surfaces  ',
      requiresPhoto: true,
    });
    const arg = db.restaurantSopTemplateStep.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.stepOrder).toBe(4);
    expect(arg.data.title).toBe('Sanitize surfaces');
    expect(arg.data.requiresPhoto).toBe(true);
    expect(arg.data.requiresSignature).toBe(false);
  });
});

describe('publishVersion', () => {
  it('rejects publishing a non-draft', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'PUBLISHED',
    });
    await expect(publishVersion(scoped(), 'v1')).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('rejects publishing a draft with no steps', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'DRAFT',
    });
    db.restaurantSopTemplateStep.count.mockResolvedValue(0);
    await expect(publishVersion(scoped(), 'v1')).rejects.toMatchObject({ reason: 'NO_STEPS' });
  });

  it('retires the prior published version and publishes the draft', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v2',
      templateId: 't1',
      versionNumber: 2,
      status: 'DRAFT',
    });
    db.restaurantSopTemplateStep.count.mockResolvedValue(3);
    const now = new Date('2026-05-01T00:00:00.000Z');
    await publishVersion(scoped(), 'v2', now);
    expect(db.restaurantSopTemplateVersion.updateMany).toHaveBeenCalledWith({
      where: { templateId: 't1', status: 'PUBLISHED' },
      data: { status: 'RETIRED', retiredAt: now },
    });
    expect(db.restaurantSopTemplateVersion.update).toHaveBeenCalledWith({
      where: { id: 'v2' },
      data: { status: 'PUBLISHED', publishedAt: now },
    });
  });
});

describe('createDraftVersion', () => {
  it('rejects when a draft already exists', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({ id: 't1' });
    db.restaurantSopTemplateVersion.findMany.mockResolvedValue([
      { id: 'v2', versionNumber: 2, status: 'DRAFT' },
      { id: 'v1', versionNumber: 1, status: 'PUBLISHED' },
    ]);
    await expect(createDraftVersion(scoped(), 't1')).rejects.toMatchObject({
      reason: 'DRAFT_EXISTS',
    });
  });

  it('clones steps forward from the latest version into a new DRAFT', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({ id: 't1' });
    db.restaurantSopTemplateVersion.findMany.mockResolvedValue([
      { id: 'v1', versionNumber: 1, status: 'PUBLISHED' },
    ]);
    db.restaurantSopTemplateStep.findMany.mockResolvedValue([
      {
        stepOrder: 1,
        title: 'A',
        instructions: null,
        requiresPhoto: true,
        requiresSignature: false,
        requiresNote: false,
      },
      {
        stepOrder: 2,
        title: 'B',
        instructions: 'do B',
        requiresPhoto: false,
        requiresSignature: true,
        requiresNote: false,
      },
    ]);
    await createDraftVersion(scoped(), 't1');
    const arg = db.restaurantSopTemplateVersion.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.versionNumber).toBe(2);
    expect(arg.data.status).toBe('DRAFT');
    expect(arg.data.steps).toEqual({
      create: [
        {
          stepOrder: 1,
          title: 'A',
          instructions: null,
          requiresPhoto: true,
          requiresSignature: false,
          requiresNote: false,
        },
        {
          stepOrder: 2,
          title: 'B',
          instructions: 'do B',
          requiresPhoto: false,
          requiresSignature: true,
          requiresNote: false,
        },
      ],
    });
  });

  it('rejects a cloneFrom that does not belong to the template', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({ id: 't1' });
    db.restaurantSopTemplateVersion.findMany.mockResolvedValue([
      { id: 'v1', versionNumber: 1, status: 'PUBLISHED' },
    ]);
    await expect(
      createDraftVersion(scoped(), 't1', { cloneFromVersionId: 'other' })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });
});

describe('retireVersion + resolveLatestPublishedVersion', () => {
  it('rejects retiring a non-published version', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'DRAFT',
    });
    await expect(retireVersion(scoped(), 'v1')).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('resolveLatestPublishedVersion asks for the highest published version', async () => {
    db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({ id: 'v3', versionNumber: 3 });
    const v = await resolveLatestPublishedVersion(scoped(), 't1');
    expect(v).toEqual({ id: 'v3', versionNumber: 3 });
    expect(db.restaurantSopTemplateVersion.findFirst).toHaveBeenCalledWith({
      where: { templateId: 't1', status: 'PUBLISHED' },
      orderBy: { versionNumber: 'desc' },
    });
  });
});
