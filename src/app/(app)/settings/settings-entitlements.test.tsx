import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

type MutationOptions = {
  onError?: (error: { message: string; data?: { code?: string } }) => void;
};

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: 'user_1', name: 'Admin', role: 'ADMIN', email: 'admin@example.com' },
  },
  apiList: { data: [] as unknown[], error: null as unknown },
  apiUsage: { data: {} as Record<string, unknown>, error: null as unknown },
  team: { data: [] as unknown[], error: null as unknown },
  webhookList: { data: [] as unknown[], error: null as unknown },
  deliveries: { data: [] as unknown[], error: null as unknown, isLoading: false },
  apiCreateOptions: undefined as MutationOptions | undefined,
  apiCreateMutate: vi.fn(),
  apiRevokeMutate: vi.fn(),
  webhookCreateMutate: vi.fn(),
  webhookUpdateMutate: vi.fn(),
  webhookDeleteMutate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mocks.session }),
  signOut: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    disabled?: boolean;
    'aria-label'?: string;
  }) => <button role="switch" aria-checked={checked} aria-label={ariaLabel} disabled={disabled} />,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      apiTokens: { list: { invalidate: vi.fn() } },
      webhooks: { list: { invalidate: vi.fn() } },
    }),
    apiTokens: {
      list: { useQuery: () => mocks.apiList },
      usage: { useQuery: () => mocks.apiUsage },
      create: {
        useMutation: (options: MutationOptions) => {
          mocks.apiCreateOptions = options;
          return { mutate: mocks.apiCreateMutate, isPending: false };
        },
      },
      revoke: {
        useMutation: () => ({ mutate: mocks.apiRevokeMutate, isPending: false }),
      },
    },
    team: { getAll: { useQuery: () => mocks.team } },
    webhooks: {
      list: { useQuery: () => mocks.webhookList },
      recentDeliveries: { useQuery: () => mocks.deliveries },
      create: {
        useMutation: () => ({ mutate: mocks.webhookCreateMutate, isPending: false }),
      },
      update: {
        useMutation: () => ({ mutate: mocks.webhookUpdateMutate, isPending: false }),
      },
      delete: {
        useMutation: () => ({ mutate: mocks.webhookDeleteMutate, isPending: false }),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { ApiTokensSection, PrintRoutingSection, WebhooksSection } from './settings-content';

function entitlementView(
  api: boolean,
  webhooks: boolean,
  source: 'OVERRIDE' | 'NONE' = 'OVERRIDE'
) {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: [api && 'api', webhooks && 'webhooks'].filter(Boolean),
    modules: [
      {
        key: 'api',
        name: 'API access',
        enabled: api,
        source,
        seatLimit: null,
        expiresAt: null,
      },
      {
        key: 'webhooks',
        name: 'Webhooks',
        enabled: webhooks,
        source,
        seatLimit: null,
        expiresAt: null,
      },
    ],
    limits: {},
  } as EntitlementView;
}

function renderSection(section: ReactNode, entitlements: EntitlementView) {
  return render(<EntitlementsProvider value={entitlements}>{section}</EntitlementsProvider>);
}

describe('Settings entitlement presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiList.data = [];
    mocks.apiList.error = null;
    mocks.apiUsage.data = {};
    mocks.apiUsage.error = null;
    mocks.team.data = [];
    mocks.team.error = null;
    mocks.webhookList.data = [];
    mocks.webhookList.error = null;
    mocks.deliveries.data = [];
    mocks.deliveries.error = null;
    mocks.apiCreateMutate.mockImplementation(() => undefined);
  });

  it('renders disabled API state without a New Token action', () => {
    renderSection(<ApiTokensSection />, entitlementView(false, true));

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(
      screen.getByText(
        'API access is disabled for this organization. Existing tokens cannot authenticate, and new tokens cannot be created. Contact your platform administrator to enable it.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'API access disabled' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'New Token' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /API Docs/ })).toHaveAttribute('href', '/api-docs');
  });

  it('renders disabled Webhooks state without a New Webhook action', () => {
    renderSection(<WebhooksSection />, entitlementView(true, false));

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Webhooks are disabled for this organization. Deliveries are paused, and new endpoints cannot be added. Events produced while disabled are not replayed.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Webhooks disabled' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'New Webhook' })).not.toBeInTheDocument();
  });

  it('renders normal creation actions when modules are enabled', () => {
    const entitlements = entitlementView(true, true);
    const api = renderSection(<ApiTokensSection />, entitlements);
    expect(screen.getByRole('button', { name: 'New Token' })).toBeEnabled();
    api.unmount();

    renderSection(<WebhooksSection />, entitlements);
    expect(screen.getByRole('button', { name: 'New Webhook' })).toBeEnabled();
  });

  it('keeps existing tokens visible and revocable while API access is disabled', () => {
    mocks.apiList.data = [
      {
        id: 'token_1',
        name: 'CI token',
        prefix: 'df_existing',
        scopes: ['*'],
        lastUsedAt: null,
        user: { id: 'user_1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' },
      },
    ];
    renderSection(<ApiTokensSection />, entitlementView(false, true));

    expect(screen.getByText('CI token')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke CI token' }));
    expect(mocks.apiRevokeMutate).toHaveBeenCalledWith({ id: 'token_1' });
  });

  it('keeps existing webhooks visible and deletable but prevents activation while disabled', () => {
    mocks.webhookList.data = [
      {
        id: 'webhook_1',
        url: 'https://example.com/hook',
        events: ['task.created'],
        active: true,
        deliveries: [],
        _count: { deliveries: 0 },
      },
    ];
    renderSection(<WebhooksSection />, entitlementView(true, false));

    expect(screen.getByText('https://example.com/hook')).toBeInTheDocument();
    expect(screen.getByText(/Paused by organization/)).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Deactivate https://example.com/hook' })
    ).toBeDisabled();
    const deleteButton = screen.getByRole('button', {
      name: 'Delete https://example.com/hook',
    });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);
    expect(mocks.webhookDeleteMutate).toHaveBeenCalledWith({ id: 'webhook_1' });
  });

  it('keeps a stale create form open and renders the readable FORBIDDEN message', () => {
    mocks.apiCreateMutate.mockImplementation(() => {
      mocks.apiCreateOptions?.onError?.({
        message: 'The API access module is not enabled for this organization.',
        data: { code: 'FORBIDDEN' },
      });
    });
    renderSection(<ApiTokensSection />, entitlementView(true, true));

    fireEvent.click(screen.getByRole('button', { name: 'New Token' }));
    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'Stale tab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Token' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The API access module is not enabled for this organization.'
    );
    expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The API access module is not enabled for this organization.'
    );
  });

  it('uses plan-oriented copy for source NONE', () => {
    renderSection(<WebhooksSection />, entitlementView(true, false, 'NONE'));

    expect(
      screen.getByText(
        'This feature is not included in your organization’s current plan. Contact your administrator or DevFathom sales to enable it.'
      )
    ).toBeInTheDocument();
  });

  it('renders a safe query fallback instead of a raw server error', () => {
    mocks.apiList.error = {
      message: 'PrismaClientKnownRequestError: sensitive database details',
      data: { code: 'INTERNAL_SERVER_ERROR' },
    };
    renderSection(<ApiTokensSection />, entitlementView(true, true));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'API tokens could not be loaded. Please try again.'
    );
    expect(screen.queryByText(/PrismaClientKnownRequestError/)).not.toBeInTheDocument();
  });
});

describe('Print routing settings', () => {
  it('renders the KOT/KDS explanation and empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ mode: 'SIMULATION_ONLY', branches: [] })))
    );
    render(<PrintRoutingSection />);
    expect(screen.getByText('Loading print routes…')).toBeInTheDocument();
    expect(
      await screen.findByText('No active restaurant branches are available.')
    ).toBeInTheDocument();
    expect(screen.getByText(/each station may use either, both, or neither/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('exposes labelled branch, station, printer, enable, and save controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              mode: 'SIMULATION_ONLY',
              branches: [
                {
                  id: 'branch-1',
                  name: 'Main branch',
                  kitchenStations: [{ id: 'station-1', name: 'Kitchen' }],
                  config: { branchId: 'branch-1', routes: [] },
                },
              ],
            })
          )
      )
    );
    render(<PrintRoutingSection />);
    await waitFor(() => expect(screen.getByLabelText('Branch')).toHaveValue('branch-1'));
    expect(screen.getByLabelText('Kitchen printer (KOT) station')).toBeInTheDocument();
    expect(screen.getByLabelText('Bar tickets printer ID')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable receipts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled();
    expect(screen.getByText(/each station may use either, both, or neither/i)).toBeVisible();
    vi.unstubAllGlobals();
  });
});
