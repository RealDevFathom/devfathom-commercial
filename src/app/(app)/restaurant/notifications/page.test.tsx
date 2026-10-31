import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';

type WebhookStatus = inferRouterOutputs<AppRouter>['restaurantNotifications']['webhookStatus'];

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
      webhookStatus: vi.fn().mockResolvedValue({
        config: null,
        deliveries: [],
        deadLetters: [],
      } satisfies WebhookStatus),
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

  it.each(['enabled', 'disabled', 'missing'] as const)(
    'exposes redacted dead letters outside the recent window with an %s endpoint',
    async (endpoint) => {
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
          config:
            endpoint === 'missing'
              ? null
              : {
                  id: 'config_1',
                  endpointUrl: 'https://hooks.example.com/sop',
                  enabled: endpoint === 'enabled',
                  signingSecretConfigured: true,
                  lastSuccessAt: null,
                  lastFailureAt: new Date(),
                  lastFailure: 'Webhook endpoint returned HTTP 503.',
                  updatedAt: new Date(),
                },
          deliveries: Array.from({ length: 20 }, (_, index) => ({
            id: `job_recent_${index}`,
            status: 'SUCCEEDED' as const,
            attempts: 1,
            nextAttemptAt: new Date(),
            lastError: null,
            createdAt: new Date('2026-10-22T00:00:00Z'),
          })),
          deadLetters: [
            {
              id: 'job_dead',
              status: 'DEAD',
              attempts: 5,
              nextAttemptAt: new Date('2026-10-20T00:00:00Z'),
              lastError: 'Webhook endpoint returned HTTP 503.',
              createdAt: new Date('2026-10-20T00:00:00Z'),
            },
          ],
        } satisfies WebhookStatus),
      });

      render(await RestaurantNotificationsPage({ searchParams }));

      expect(screen.getByRole('heading', { name: 'Dead letters requiring action' })).toBeDefined();
      expect(screen.getByText('job_dead · 5 attempts')).toBeDefined();
      const retry = screen.getByRole('button', { name: 'Retry' });
      const testDelivery = screen.getByRole('button', { name: 'Queue test delivery' });
      if (endpoint === 'enabled') {
        expect(testDelivery).toBeEnabled();
        expect(retry).toBeEnabled();
        expect(retry).toHaveAttribute('tabindex', '0');
      } else {
        expect(testDelivery).toBeDisabled();
        expect(retry).toBeDisabled();
      }
      if (endpoint === 'missing') {
        expect(screen.queryByRole('button', { name: 'Remove webhook' })).toBeNull();
      } else {
        const confirmation = screen.getByRole('checkbox', {
          name: 'I understand that the endpoint and signing secret will be deleted.',
        });
        const removalForm = screen.getByRole('button', { name: 'Remove webhook' }).closest('form')!;
        expect(confirmation).toBeRequired();
        expect(removalForm.checkValidity()).toBe(false);
        fireEvent.click(confirmation);
        expect(removalForm.checkValidity()).toBe(true);
      }
      expect(screen.getAllByText('Webhook endpoint returned HTTP 503.').length).toBeGreaterThan(0);
      expect(screen.queryByText(/signing-secret|ciphertext-only/i)).toBeNull();
    }
  );
});
