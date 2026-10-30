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
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/server/routers/restaurant-notifications', () => ({
  restaurantNotificationsRouter: { createCaller: mocks.createCaller },
}));

import RestaurantNotificationsPage from './page';
import { retryWebhookNotice } from './retry-webhook-notice';

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
    entitlements: { enabledModules: ['restaurant-core'] },
    db: { restaurantBranch: { findMany: vi.fn().mockResolvedValue([]) } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `staff:manage` denied keeps the routing-matrix branch out of this fixture;
  // the tenancy path under test is the same either way.
  mocks.can.mockResolvedValue(false);
  mocks.createCaller.mockReturnValue({
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    unreadCount: vi.fn().mockResolvedValue({ count: 0 }),
  });
});

describe('RestaurantNotificationsPage tenancy resolution', () => {
  it('states the live and unavailable channel boundary accurately', () => {
    expect(retryWebhookNotice('QUEUED')).toBe('Webhook retry is queued.');
    expect(retryWebhookNotice('RUNNING')).toBe('Webhook retry is currently running.');
    expect(retryWebhookNotice('SUCCEEDED')).toBe('Webhook retry already succeeded.');
    expect(retryWebhookNotice('FAILED')).toBe('Webhook retry finished with a permanent failure.');
    expect(retryWebhookNotice('DEAD')).toBe('Webhook retry is dead-lettered.');
  });
  it('renders with a resolvable tenant actor and does not throw', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await RestaurantNotificationsPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Notifications center' })).toBeDefined();
  });

  it('keeps the page eyebrow on the contrast-checked muted token', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await RestaurantNotificationsPage({ searchParams }));

    const eyebrow = screen.getByText('Restaurant operations');
    expect(eyebrow.className).toContain('eyebrow');
    expect(eyebrow.className).not.toContain('eyebrow-accent');
  });

  it('never asks the context factory to re-resolve tenancy', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    await RestaurantNotificationsPage({ searchParams });

    // A bare `createTRPCContext()` always throws `Workspace not found.`: the
    // `{ session: undefined }` it forwards suppresses the `auth()` call.
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
  });

  it('renders the access state instead of throwing when the organization is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    render(await RestaurantNotificationsPage({ searchParams }));

    expect(screen.getByText('Permission denied')).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });

  it('renders labeled webhook controls and a disabled test action when the endpoint is disabled', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());
    mocks.can.mockResolvedValue(true);
    mocks.createCaller.mockReturnValue({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      unreadCount: vi.fn().mockResolvedValue({ count: 0 }),
      getMatrix: vi.fn().mockResolvedValue({
        category: 'sop.escalation',
        branchId: null,
        channels: ['IN_APP', 'WEBHOOK', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'].map((channel) => ({
          channel,
          enabled: true,
        })),
      }),
      webhookStatus: vi.fn().mockResolvedValue({ config: null, deliveries: [] }),
    });

    render(await RestaurantNotificationsPage({ searchParams }));

    expect(screen.getByLabelText('HTTPS endpoint')).toBeDefined();
    expect(screen.getByLabelText('New signing secret')).toHaveAttribute(
      'aria-describedby',
      'webhook-secret-help'
    );
    expect(screen.getByRole('button', { name: 'Queue test delivery' })).toBeDisabled();
    expect(screen.getByText('Signed webhook')).toBeDefined();
    expect(screen.getByText(/In-app and signed webhooks are live delivery channels/)).toBeDefined();
    expect(screen.getByText(/Email, SMS, push, and WhatsApp are unavailable/)).toBeDefined();
  });

  it('renders notification meta text with the contrast-checked token, never text-faint', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());
    mocks.can.mockResolvedValue(false);
    const readAt = new Date('2026-10-20T12:00:00Z');
    mocks.createCaller.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'ntf_1',
            branchId: null,
            category: 'sop.escalation',
            title: 'Escalation acknowledged',
            body: 'The overdue checklist was acknowledged.',
            entityType: 'checklist',
            entityId: 'chk_1',
            isRead: true,
            readAt,
            createdAt: new Date('2026-10-20T11:00:00Z'),
            deliveries: [],
          },
        ],
        nextCursor: null,
      }),
      unreadCount: vi.fn().mockResolvedValue({ count: 0 }),
    });

    render(await RestaurantNotificationsPage({ searchParams }));

    // `text-text-faint` (slate-400) sits at ~2:1 on the card surface and is not
    // in the contrast-checked token set; the meta lines must use `text-text-muted`.
    const readLine = screen.getByText(/^Read /);
    expect(readLine.className).toContain('text-text-muted');
    expect(readLine.className).not.toContain('text-text-faint');
    const relatedLine = screen.getByText(/^Related:/);
    expect(relatedLine.className).toContain('text-text-muted');
    expect(relatedLine.className).not.toContain('text-text-faint');
  });

  it('exposes enabled test, redacted error, and keyboard-reachable dead-letter retry states', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());
    mocks.can.mockResolvedValue(true);
    mocks.createCaller.mockReturnValue({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      unreadCount: vi.fn().mockResolvedValue({ count: 0 }),
      getMatrix: vi.fn().mockResolvedValue({
        category: 'sop.escalation',
        branchId: null,
        channels: ['IN_APP', 'WEBHOOK', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'].map((channel) => ({
          channel,
          enabled: true,
        })),
      }),
      webhookStatus: vi.fn().mockResolvedValue({
        config: {
          id: 'config_1',
          endpointUrl: 'https://hooks.example.com/sop',
          enabled: true,
          signingSecretConfigured: true,
          lastSuccessAt: null,
          lastFailureAt: new Date(),
          lastFailure: 'Webhook endpoint returned HTTP 503.',
          updatedAt: new Date(),
        },
        deliveries: [
          {
            id: 'job_dead',
            status: 'DEAD',
            attempts: 5,
            nextAttemptAt: null,
            lastError: 'Webhook endpoint returned HTTP 503.',
            createdAt: new Date(),
          },
        ],
      }),
    });

    render(await RestaurantNotificationsPage({ searchParams }));

    expect(screen.getByRole('button', { name: 'Queue test delivery' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('tabindex', '0');
    expect(screen.getAllByText('Webhook endpoint returned HTTP 503.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/signing-secret|ciphertext-only/i)).toBeNull();
  });
});
