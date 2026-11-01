/**
 * UPS-04 — a draft is rewritten only by a save that names it by its time AND
 * its wording, even if the input contract stops saying so.
 *
 * `journeyTemplateDraftInput` states "time and wording together" as a zod
 * `.refine`, and the router joins the property selection onto it with
 * `.extend()`. A refinement lives only as long as every such step keeps it, and
 * without it a save naming only `expectedUpdatedAt` would rewrite a draft bound
 * by its timestamp alone — the race two writes in one millisecond win. This
 * suite removes the refinement (the contract below is the lib's own shape with
 * no checks) and drives the real router: the rule must still hold at run time.
 * The router's own suite covers everything else with the contract intact.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/hotel/journey-templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hotel/journey-templates')>();
  // The same fields, none of the refinements: as if `.extend()` had dropped them.
  return { ...actual, journeyTemplateDraftInput: z.object(actual.journeyTemplateDraftInput.shape) };
});
vi.mock('@/server/hotel-property-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: mocks.scope,
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { $transaction: vi.fn() } }));
vi.mock('../trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    adminProcedure: t.procedure,
    capabilityProcedure: () => t.procedure,
    auditedProtectedProcedure: t.procedure,
  };
});
import { journeyTemplateDraftInput } from '@/lib/hotel/journey-templates';
import { hotelPropertyRouter } from './hotel-property';

const ORG = 'org_1';
const BRANCH = 'property_1';
const readAt = new Date('2026-09-14T00:00:00.000Z');
const property = {
  branchId: BRANCH,
  organizationId: ORG,
  name: 'Synthetic',
  timezone: 'UTC',
  journeySettings: {},
  active: true,
};
const stored = {
  id: 'draft_1',
  organizationId: ORG,
  branchId: BRANCH,
  moment: 'WELCOME' as const,
  channel: 'EMAIL' as const,
  language: 'EN' as const,
  subject: 'Welcome to {{property_name}}',
  body: 'Hello {{guest_name}}.',
  version: 1,
  status: 'DRAFT' as const,
  createdByUserId: 'author',
  approvedByUserId: null,
  approvedAt: null,
  createdAt: readAt,
  updatedAt: readAt,
};
const save = {
  branchId: BRANCH,
  moment: stored.moment,
  channel: stored.channel,
  language: stored.language,
  subject: stored.subject,
  body: 'Replacement {{guest_name}}.',
};

const templates = {
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
};
const db = {
  $transaction: vi.fn(async (run: (value: unknown) => Promise<unknown>) => run(db)),
  $queryRaw: vi.fn(async () => [{ branchId: BRANCH }]),
  hotelProperty: { findFirst: vi.fn(async () => property) },
  hotelJourneyTemplate: templates,
};
const caller = () =>
  hotelPropertyRouter.createCaller({
    session: { user: { id: 'editor', organizationId: ORG, role: 'EMPLOYEE' } },
    entitlements: { organizationId: ORG, enabledModules: ['hotel-core', 'hotel-upsell'] },
    db,
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as never).journeyTemplates;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue(property);
  templates.findFirst.mockResolvedValue({ ...stored });
  templates.updateMany.mockResolvedValue({ count: 1 });
  templates.create.mockResolvedValue({ ...stored, id: 'created' });
});

describe('hotelProperty.journeyTemplates.save without the contract’s refinement', () => {
  it('runs on a contract that would let a time-only reading through', () => {
    expect(
      journeyTemplateDraftInput.safeParse({ ...save, expectedUpdatedAt: readAt }).success
    ).toBe(true);
  });

  it.each([
    ['its time alone', { expectedUpdatedAt: readAt }],
    ['its time and body, no subject', { expectedUpdatedAt: readAt, expectedBody: stored.body }],
    [
      'its time and subject, no body',
      { expectedUpdatedAt: readAt, expectedSubject: stored.subject },
    ],
  ])('still refuses to rewrite a draft named by %s, writing nothing', async (_label, named) => {
    const error = await caller()
      .save({ ...save, ...named })
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Name the draft you read by its time and its wording together.',
    });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['expectedUpdatedAt'] })],
    });
    expect(templates.updateMany).not.toHaveBeenCalled();
    expect(templates.create).not.toHaveBeenCalled();
  });

  it('rewrites the draft when the save names its time and its wording', async () => {
    await caller().save({
      ...save,
      expectedUpdatedAt: readAt,
      expectedSubject: stored.subject,
      expectedBody: stored.body,
    });
    expect(templates.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: stored.id,
        updatedAt: readAt,
        subject: stored.subject,
        body: stored.body,
      }),
      data: { subject: stored.subject, body: save.body },
    });
  });
});
