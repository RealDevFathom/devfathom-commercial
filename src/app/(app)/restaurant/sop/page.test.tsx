import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  can: vi.fn(),
  createCaller: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/server/routers/restaurant-sop-execution', () => ({
  restaurantSopExecutionRouter: { createCaller: mocks.createCaller },
}));

import SopPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

const searchParams = Promise.resolve({});

function contextStub() {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { enabledModules: ['restaurant-sop'] },
    db: {
      restaurantBranch: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.createCaller.mockReturnValue({});
});

describe('SopPage tenancy resolution', () => {
  it('renders with a resolvable tenant actor and does not throw', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await SopPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Branch SOP board' })).toBeDefined();
    expect(screen.queryByText('Permission denied')).toBeNull();
  });

  it('never asks the context factory to re-resolve tenancy', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    await SopPage({ searchParams });

    // A bare `createTRPCContext()` always throws `Workspace not found.`: the
    // `{ session: undefined }` it forwards suppresses the `auth()` call.
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
  });

  it('renders the board access state instead of throwing when the organization is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    render(await SopPage({ searchParams }));

    expect(screen.getByText('Permission denied')).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });
});

describe('SopPage load failure', () => {
  it('renders a safe recovery state without exposing the server failure', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    const ctx = contextStub();
    ctx.db.restaurantBranch.findMany.mockRejectedValue(
      new Error('503 database host: private.internal')
    );
    mocks.createTRPCContext.mockResolvedValue(ctx);

    render(await SopPage({ searchParams }));

    expect(screen.getByText('SOP board could not load')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry SOP board' })).toBeInTheDocument();
    expect(screen.queryByText(/private\.internal/)).not.toBeInTheDocument();
  });
});

describe('SOP credential approval form', () => {
  it('requires a masked approving credential, supports PIN and badge, and attributes actors to the session', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    const ctx = contextStub();
    ctx.db.restaurantBranch.findMany.mockResolvedValue([
      {
        id: 'branch-1',
        name: 'Main branch',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    ] as never);
    ctx.db.restaurantStaffProfile.findMany.mockResolvedValue([
      {
        id: 'staff-1',
        displayName: 'Approving manager',
      },
    ] as never);
    mocks.createTRPCContext.mockResolvedValue(ctx);
    const date = new Date('2026-08-29T12:00:00Z');
    const detail = {
      id: 'occ-1',
      status: 'MISSED',
      businessDate: date,
      dueAt: date,
      windowEndsAt: date,
      assignment: { template: { name: 'Opening check', category: 'Operations' } },
      templateVersion: { versionNumber: 1, steps: [] },
      steps: [],
      evidence: [],
      verifications: [],
      escalationEvents: [],
    };
    mocks.createCaller.mockReturnValue({
      listOccurrences: vi.fn(async ({ status }: { status: string }) => ({
        items: status === 'MISSED' ? [detail] : [],
        nextCursor: null,
      })),
      getOccurrence: vi.fn(async () => detail),
    });
    const view = await SopPage({ searchParams });
    const { container } = render(view);
    const credential = screen.getByLabelText('Approving manager credential');
    expect(credential).toHaveAttribute('type', 'password');
    expect(credential).toBeRequired();
    expect(screen.getByLabelText('Approving credential type')).toHaveTextContent('PINBadge');
    expect(container.querySelector('[name="actorStaffProfileId"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Waive occurrence' })).toBeEnabled();
  });
});

describe('SOP waiver credential form', () => {
  it('collects the approving credential and uses session attribution', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    const ctx = contextStub();
    ctx.db.restaurantBranch.findMany.mockResolvedValue([
      {
        id: 'branch-1',
        name: 'Main',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    ] as never);
    ctx.db.restaurantStaffProfile.findMany.mockResolvedValue([
      {
        id: 'staff-1',
        displayName: 'Manager',
      },
    ] as never);
    mocks.createTRPCContext.mockResolvedValue(ctx);
    const detail = {
      id: 'occ-1',
      status: 'MISSED',
      businessDate: new Date('2026-10-28'),
      dueAt: new Date('2026-10-28T10:00:00Z'),
      windowEndsAt: new Date('2026-10-28T11:00:00Z'),
      assignment: { template: { name: 'Opening checklist', category: 'Safety' } },
      templateVersion: { versionNumber: 1, steps: [] },
      steps: [],
      evidence: [],
      verifications: [],
      escalationEvents: [],
    };
    mocks.createCaller.mockReturnValue({
      listOccurrences: vi.fn(async ({ status }) => ({
        items: status === 'MISSED' ? [detail] : [],
      })),
      getOccurrence: vi.fn(async () => detail),
    });
    const { container } = render(await SopPage({ searchParams }));
    expect(screen.getByLabelText('Approving manager credential')).toHaveAttribute(
      'type',
      'password'
    );
    expect(screen.getByLabelText('Approving manager credential')).toBeRequired();
    expect(screen.getByLabelText('Approving credential type')).toHaveValue('PIN');
    expect(screen.getByLabelText('Approving co-author')).toBeRequired();
    expect(container.querySelector('[name="actorStaffProfileId"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Waive occurrence' })).toBeEnabled();
  });
});

describe('DEV-837: captured proof versus unverified metadata', () => {
  async function renderWithEvidence(serverCaptured: boolean) {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    const ctx = contextStub();
    ctx.db.restaurantBranch.findMany.mockResolvedValue([
      { id: 'branch-1', name: 'Main branch', timezone: 'UTC', businessDayCutoff: '00:00' },
    ] as never);
    ctx.db.restaurantStaffProfile.findMany.mockResolvedValue([
      { id: 'staff-1', displayName: 'Line cook' },
    ] as never);
    mocks.createTRPCContext.mockResolvedValue(ctx);
    const date = new Date('2026-08-29T12:00:00Z');
    const detail = {
      id: 'occ-1',
      status: 'IN_PROGRESS',
      businessDate: date,
      dueAt: date,
      windowEndsAt: date,
      assignment: { template: { name: 'Fridge check', category: 'Food safety' } },
      templateVersion: {
        versionNumber: 1,
        steps: [
          {
            id: 'tmpl-step-1',
            stepOrder: 1,
            title: 'Photograph the fridge thermometer',
            instructions: null,
            requiresPhoto: true,
            requiresSignature: false,
            requiresNote: false,
          },
        ],
      },
      steps: [
        {
          id: 'occ-step-1',
          templateStepId: 'tmpl-step-1',
          completed: false,
          completedAt: null,
          completedByStaffProfileId: null,
          note: null,
        },
      ],
      evidence: [
        {
          id: 'ev-1',
          occurrenceStepId: 'occ-step-1',
          contentHash: 'a'.repeat(64),
          mimeType: 'image/jpeg; evidence=photo',
          sizeBytes: serverCaptured ? 2048 : 0,
          storageRef: serverCaptured ? '/api/files/sop-proof.jpg' : null,
          uploaderStaffProfileId: 'staff-1',
          capturedAt: date,
          serverCaptured,
        },
      ],
      verifications: [],
      escalationEvents: [],
      claimable: false,
    };
    mocks.createCaller.mockReturnValue({
      listOccurrences: vi.fn(async ({ status }: { status: string }) => ({
        items: status === 'IN_PROGRESS' ? [detail] : [],
        nextCursor: null,
      })),
      getOccurrence: vi.fn(async () => detail),
    });
    render(await SopPage({ searchParams }));
  }

  it('labels metadata-only proof as unverified and keeps the step blocked', async () => {
    await renderWithEvidence(false);
    expect(screen.getByText('Unverified metadata')).toBeInTheDocument();
    expect(screen.queryByText('Captured proof')).toBeNull();
    expect(screen.getByText(/does not count as photo or signature proof/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete step' })).toBeDisabled();
  });

  it('labels captured proof and lets the step complete', async () => {
    await renderWithEvidence(true);
    expect(screen.getByText('Captured proof')).toBeInTheDocument();
    expect(screen.queryByText('Unverified metadata')).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete step' })).toBeEnabled();
  });
});
