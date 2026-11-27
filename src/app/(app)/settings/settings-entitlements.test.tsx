import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verticalForModuleKey, type EntitlementView } from '@/lib/module-catalog';

type MutationOptions = {
  onError?: (error: { message: string; data?: { code?: string } }) => void;
};

const mocks = vi.hoisted(() => ({
  session: {
    user: {
      id: 'user_1',
      organizationId: 'org_1',
      name: 'Admin',
      role: 'ADMIN',
      email: 'admin@example.com',
    },
  },
  printingClient: { restaurantDevices: { listPrinters: { query: vi.fn().mockResolvedValue([]) } } },
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
  useSession: () => ({ data: mocks.session, status: 'authenticated' }),
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
      client: mocks.printingClient,
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
import {
  ApiTokensSection,
  PrintRoutingSection,
  ReceiptDesignerLink,
  WebhooksSection,
} from './settings-content';

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

describe('Receipt designer link', () => {
  const name = 'Receipt designer and layout settings';

  it('links to the receipt designer for restaurant organizations', () => {
    renderSection(<ReceiptDesignerLink />, {
      ...entitlementView(true, true),
      vertical: verticalForModuleKey('restaurant-core')!,
    });
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', '/settings/receipts');
  });

  it.each(['PHARMACY', 'HOSPITALITY', 'AGENCY'] as const)('hides the link for %s', (vertical) => {
    renderSection(<ReceiptDesignerLink />, { ...entitlementView(true, true), vertical });
    expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
  });

  it('hides the link when the vertical is unknown', () => {
    renderSection(<ReceiptDesignerLink />, entitlementView(true, true));
    expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
  });
});

describe('Print routing settings', () => {
  it('preserves sibling station routes when editing and saving the first route', async () => {
    const routes = [
      {
        documentType: 'KITCHEN_TICKET',
        stationId: 'hot',
        printerId: 'queue:///Hot',
        enabled: true,
      },
      {
        documentType: 'KITCHEN_TICKET',
        stationId: 'cold',
        printerId: 'queue:///Cold',
        enabled: true,
      },
      { documentType: 'RECEIPT', stationId: null, printerId: 'queue:///Receipt', enabled: true },
    ];
    const fetchMock = vi.fn(
      async (_path: unknown, options?: RequestInit) =>
        new Response(
          JSON.stringify(
            options?.method === 'PUT'
              ? {}
              : {
                  branches: [
                    {
                      id: 'branch-1',
                      name: 'Main',
                      kitchenStations: [
                        { id: 'hot', name: 'Hot' },
                        { id: 'cold', name: 'Cold' },
                      ],
                      config: { branchId: 'branch-1', routes },
                    },
                  ],
                }
          )
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    renderSection(<PrintRoutingSection />, entitlementView(true, true));
    fireEvent.change(await screen.findByLabelText('Kitchen printer (KOT) printer ID'), {
      target: { value: 'queue:///NewHot' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save print routes' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const put = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')!;
    expect(JSON.parse(put[1]!.body as string).routes).toEqual([
      { ...routes[0], printerId: 'queue:///NewHot', registeredPrinterId: null },
      { ...routes[1], registeredPrinterId: null },
      { ...routes[2], registeredPrinterId: null },
    ]);
    vi.unstubAllGlobals();
  });
  it('dispatches a synthetic receipt test with stable retry identity and honest delivery status', async () => {
    const fetchMock = vi.fn(
      async (_path: unknown, options?: RequestInit) =>
        new Response(
          JSON.stringify(
            options?.method === 'POST'
              ? { result: { status: 'QUEUED', printerId: 'queue:///Receipt' } }
              : {
                  mode: 'DEVICE_BRIDGE',
                  branches: [
                    {
                      id: 'branch-1',
                      name: 'Main',
                      kitchenStations: [],
                      config: {
                        branchId: 'branch-1',
                        routes: [
                          {
                            documentType: 'RECEIPT',
                            stationId: null,
                            printerId: 'queue:///Receipt',
                            enabled: true,
                          },
                        ],
                      },
                    },
                  ],
                }
          )
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    renderSection(<PrintRoutingSection />, entitlementView(true, true));
    const button = await screen.findByRole('button', { name: 'Test receipt printer' });
    fireEvent.click(button);
    expect(await screen.findByText(/Paper output is not confirmed/)).toBeVisible();
    fireEvent.click(button);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
        2
      )
    );
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    const first = JSON.parse(posts[0][1]!.body as string);
    // The server authors the synthetic receipt; the browser supplies no printable content.
    expect(first).toEqual({
      branchId: 'branch-1',
      idempotencyKey: expect.stringMatching(/^receipt-test:[A-Za-z0-9-]{8,128}$/),
      expectedDestination: expect.any(Object),
    });
    expect(first).not.toHaveProperty('document');
    expect(first).not.toHaveProperty('stationId');
    expect(posts[1][1]!.body).toBe(posts[0][1]!.body);
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///Other' },
    });
    expect(button).toBeDisabled();
    vi.unstubAllGlobals();
  });
  it('renders the KOT/KDS explanation and empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ mode: 'SIMULATION_ONLY', branches: [] })))
    );
    renderSection(<PrintRoutingSection />, entitlementView(true, true));
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
    renderSection(<PrintRoutingSection />, entitlementView(true, true));
    await waitFor(() =>
      expect(
        selectFieldControl(
          screen.getByLabelText('Branch', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).toHaveValue('branch-1')
    );
    expect(
      screen.getByLabelText('Kitchen printer (KOT) station', {
        selector: ':not([data-select-field-native][aria-hidden="true"])',
      })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Bar tickets printer ID')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable receipts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled();
    expect(screen.getByText(/each station may use either, both, or neither/i)).toBeVisible();
    vi.unstubAllGlobals();
  });
});
