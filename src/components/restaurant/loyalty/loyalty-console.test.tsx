import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => {
  const query = <T,>(data: T) => ({
    data,
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  });
  const customer = {
    id: 'customer_1',
    displayName: 'Ada Lovelace',
    givenName: 'Ada',
    familyName: 'Lovelace',
    birthDate: null,
    notes: null,
    anonymizedAt: null,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    identifiers: [
      {
        id: 'identifier_1',
        kind: 'EMAIL' as const,
        normalizedValue: 'ada@example.com',
        verifiedAt: new Date('2026-08-01T10:00:00.000Z'),
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        updatedAt: new Date('2026-08-01T10:00:00.000Z'),
      },
    ],
    interactions: [
      {
        id: 'interaction_1',
        branchId: 'branch_1',
        branch: { id: 'branch_1', name: 'Downtown' },
        orderId: 'order_1',
        order: { id: 'order_1', branchId: 'branch_1', orderNumber: '1042', status: 'CLOSED' },
        type: 'VISIT',
        payload: null,
        occurredAt: new Date('2026-08-20T18:00:00.000Z'),
        idempotencyKey: 'interaction-key',
        createdAt: new Date('2026-08-20T18:00:00.000Z'),
      },
    ],
    orders: [],
    tags: [
      {
        id: 'tag_regular',
        name: 'Regular',
        color: null,
        assignedAt: new Date('2026-08-02T10:00:00.000Z'),
      },
    ],
    consentEvents: [
      {
        id: 'consent_1',
        channel: 'EMAIL' as const,
        granted: true,
        source: 'checkout',
        actorId: 'user_1',
        policyVersion: 'v1',
        occurredAt: new Date('2026-08-03T10:00:00.000Z'),
        idempotencyKey: 'consent-key',
        createdAt: new Date('2026-08-03T10:00:00.000Z'),
      },
    ],
    currentConsent: {
      EMAIL: {
        id: 'consent_1',
        channel: 'EMAIL' as const,
        granted: true,
        source: 'checkout',
        actorId: 'user_1',
        policyVersion: 'v1',
        occurredAt: new Date('2026-08-03T10:00:00.000Z'),
        idempotencyKey: 'consent-key',
        createdAt: new Date('2026-08-03T10:00:00.000Z'),
      },
    },
    loyaltySummary: {
      id: 'account_1',
      active: true,
      enrolledAt: new Date('2026-08-04T10:00:00.000Z'),
      deactivatedAt: null,
      balance: 175,
    },
  };
  const listedCustomer = {
    id: customer.id,
    displayName: customer.displayName,
    givenName: customer.givenName,
    familyName: customer.familyName,
    birthDate: customer.birthDate,
    notes: customer.notes,
    anonymizedAt: customer.anonymizedAt,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    identifiers: customer.identifiers,
    interactions: customer.interactions.map(
      ({ orderId, order, payload, idempotencyKey, createdAt, ...row }) => {
        void orderId;
        void order;
        void payload;
        void idempotencyKey;
        void createdAt;
        return row;
      }
    ),
    tags: customer.tags,
  };
  const program = {
    id: 'program_1',
    organizationId: 'org_1',
    versionNumber: 2,
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    earnRate: '1.000000',
    redemptionValue: '0.010000',
    expiryDays: 365,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  const account = {
    id: 'account_1',
    organizationId: 'org_1',
    customerId: 'customer_1',
    active: true,
    enrolledAt: new Date('2026-08-04T10:00:00.000Z'),
    deactivatedAt: null,
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
    updatedAt: new Date('2026-08-04T10:00:00.000Z'),
    customer: { id: 'customer_1', displayName: 'Ada Lovelace', anonymizedAt: null },
    balance: 175,
  };
  const ledger = [
    {
      id: 'entry_1',
      organizationId: 'org_1',
      accountId: 'account_1',
      programVersionId: 'program_1',
      kind: 'EARN' as const,
      points: 200,
      billId: 'bill_1',
      refundId: null,
      reversesEntryId: null,
      actorId: null,
      reason: 'Order earn',
      expiresAt: null,
      occurredAt: new Date('2026-08-18T10:00:00.000Z'),
      idempotencyKey: 'earn-key',
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
      programVersion: program,
    },
    {
      id: 'entry_2',
      organizationId: 'org_1',
      accountId: 'account_1',
      programVersionId: 'program_1',
      kind: 'REDEEM' as const,
      points: -25,
      billId: 'bill_2',
      refundId: null,
      reversesEntryId: null,
      actorId: 'user_1',
      reason: 'Bill redemption',
      expiresAt: null,
      occurredAt: new Date('2026-08-19T10:00:00.000Z'),
      idempotencyKey: 'redeem-key',
      createdAt: new Date('2026-08-19T10:00:00.000Z'),
      programVersion: program,
    },
  ];
  const initial = {
    customers: { customers: [listedCustomer], nextCursor: null },
    customer,
    tags: [
      { id: 'tag_regular', name: 'Regular', color: null, createdAt: new Date('2026-08-01') },
      { id: 'tag_vip', name: 'VIP', color: null, createdAt: new Date('2026-08-01') },
    ],
    programs: [program],
    accounts: [account],
    account,
    ledger,
  };
  const enabled = {
    customers: [] as boolean[],
    tags: [] as boolean[],
    programs: [] as boolean[],
    accounts: [] as boolean[],
  };
  const mutations = Object.fromEntries(
    [
      'assignTag',
      'unassignTag',
      'appendConsent',
      'appendInteraction',
      'export',
      'anonymize',
      'enrollAccount',
      'configure',
      'adjust',
    ].map((key) => [key, [] as unknown[]])
  ) as Record<string, unknown[]>;
  const invalidations = vi.fn();
  const detailInputs: unknown[] = [];
  return {
    initial,
    customers: query(initial.customers),
    detail: query(initial.customer),
    tags: query(initial.tags),
    programs: query(initial.programs),
    accounts: query(initial.accounts),
    account: query(initial.account),
    ledger: query(initial.ledger),
    enabled,
    mutations,
    invalidations,
    detailInputs,
  };
});

vi.mock('@/lib/trpc', () => {
  const query = (
    key: 'customers' | 'detail' | 'tags' | 'programs' | 'accounts' | 'account' | 'ledger'
  ) => ({
    useQuery: (input: unknown, options?: { enabled?: boolean }) => {
      if (key in mocks.enabled) {
        mocks.enabled[key as keyof typeof mocks.enabled].push(options?.enabled ?? true);
      }
      if (key === 'detail') mocks.detailInputs.push(input);
      return mocks[key];
    },
  });
  const mutation = (key: string, result: unknown = {}) => ({
    useMutation: (options?: { onSuccess?: (data: unknown) => void }) => ({
      isPending: false,
      mutate: (input: unknown) => {
        mocks.mutations[key]!.push(input);
        options?.onSuccess?.(result);
      },
    }),
  });
  const invalidate = () => ({ invalidate: mocks.invalidations });
  return {
    trpc: {
      restaurantStaff: {
        listBranches: {
          useQuery: () => ({
            data: [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }],
            error: null,
            isLoading: false,
          }),
        },
      },
      restaurantCustomers: {
        list: query('customers'),
        detail: query('detail'),
        listTags: query('tags'),
        assignTag: mutation('assignTag'),
        unassignTag: mutation('unassignTag'),
        appendConsent: mutation('appendConsent'),
        appendInteraction: mutation('appendInteraction'),
        export: mutation('export', { profile: {}, identifiers: [] }),
        anonymize: mutation('anonymize'),
      },
      restaurantOrders: {
        listOrders: {
          useQuery: () => ({
            data: {
              orders: [
                {
                  id: 'order_internal_1',
                  orderNumber: 1042,
                  businessDate: '2026-08-19',
                  status: 'CLOSED',
                },
              ],
              nextCursor: null,
            },
            error: null,
            isError: false,
            isLoading: false,
          }),
        },
      },
      restaurantLoyalty: {
        listPrograms: query('programs'),
        listAccounts: query('accounts'),
        getAccount: query('account'),
        listLedger: query('ledger'),
        enrollAccount: mutation('enrollAccount'),
        configure: mutation('configure'),
        adjust: mutation('adjust'),
      },
      useUtils: () => ({
        restaurantCustomers: { list: invalidate(), detail: invalidate() },
        restaurantLoyalty: {
          listAccounts: invalidate(),
          listPrograms: invalidate(),
          getAccount: invalidate(),
          listLedger: invalidate(),
        },
      }),
    },
  };
});

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { LoyaltyConsole } from './loyalty-console';

function entitlements(enabled: boolean): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled ? ['restaurant-loyalty'] : [],
    modules: [
      {
        key: 'restaurant-loyalty',
        name: 'Customers and Loyalty',
        enabled,
        source: enabled ? 'OVERRIDE' : 'NONE',
        seatLimit: null,
        expiresAt: null,
      },
    ],
    limits: {},
  };
}

function renderConsole(enabled = true) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <LoyaltyConsole />
    </EntitlementsProvider>
  );
}

describe('Customers & Loyalty console', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.customers.data = mocks.initial.customers;
    mocks.detail.data = mocks.initial.customer;
    mocks.tags.data = mocks.initial.tags;
    mocks.programs.data = mocks.initial.programs;
    mocks.accounts.data = mocks.initial.accounts;
    mocks.account.data = mocks.initial.account;
    mocks.ledger.data = mocks.initial.ledger;
    [
      mocks.customers,
      mocks.detail,
      mocks.tags,
      mocks.programs,
      mocks.accounts,
      mocks.account,
      mocks.ledger,
    ].forEach((query) => {
      query.error = null;
      query.isLoading = false;
    });
    Object.values(mocks.enabled).forEach((calls) => {
      calls.length = 0;
    });
    Object.values(mocks.mutations).forEach((calls) => {
      calls.length = 0;
    });
    mocks.detailInputs.length = 0;
  });

  it('renders operational data with keyboard-scrollable tables and explicit consent defaults', () => {
    renderConsole();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Customers & Loyalty' })
    ).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Downtown')).toBeInTheDocument();
    expect(screen.getAllByText('Denied — no event')).toHaveLength(4);
    expect(screen.getByText('bill_2')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Customer search results' })).toHaveAttribute(
      'tabindex',
      '0'
    );
    expect(screen.getByRole('region', { name: 'Loyalty points ledger' })).toHaveAttribute(
      'tabindex',
      '0'
    );
  });

  it('selects customer rows with pointer and keyboard input', () => {
    mocks.customers.data = {
      customers: [
        ...mocks.initial.customers.customers,
        {
          ...mocks.initial.customers.customers[0]!,
          id: 'customer_2',
          displayName: 'Grace Hopper',
        },
      ],
      nextCursor: null,
    };
    renderConsole();

    const rows = screen.getAllByRole('row').filter((row) => row.querySelector('button'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-state', 'selected');

    fireEvent.click(rows[1]);
    expect(rows[1]).toHaveAttribute('data-state', 'selected');
    expect(rows[0]).not.toHaveAttribute('data-state');
    expect(mocks.detailInputs.at(-1)).toEqual({ customerId: 'customer_2' });

    fireEvent.keyDown(rows[0], { key: 'Enter' });
    expect(rows[0]).toHaveAttribute('data-state', 'selected');

    fireEvent.keyDown(rows[1], { key: ' ' });
    expect(rows[1]).toHaveAttribute('data-state', 'selected');
  });

  it('renders the route loading state without exposing stale records', () => {
    mocks.customers.isLoading = true;
    renderConsole();

    expect(screen.getByRole('status', { name: 'Loading customer records' })).toBeInTheDocument();
    expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument();
  });

  it('renders a useful empty state', () => {
    mocks.customers.data = { customers: [], nextCursor: null };
    renderConsole();

    expect(screen.getByText('No customers found')).toBeInTheDocument();
    expect(screen.getByText('No customer selected')).toBeInTheDocument();
  });

  it('renders a retryable generic error state', () => {
    mocks.customers.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    renderConsole();

    expect(screen.getByText('Customers & Loyalty could not load')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.customers.refetch).toHaveBeenCalledOnce();
  });

  it('fails closed on permission denial and hides cached PII', () => {
    mocks.customers.error = { data: { code: 'FORBIDDEN' } };
    renderConsole();

    expect(screen.getByText('Customers & Loyalty access denied')).toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('disables every read when the module is unavailable', () => {
    renderConsole(false);

    expect(screen.getByText('Customers & Loyalty module disabled')).toBeInTheDocument();
    expect(mocks.enabled.customers.at(-1)).toBe(false);
    expect(mocks.enabled.programs.at(-1)).toBe(false);
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
  });

  it('requires typed destructive confirmation before anonymizing', async () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Anonymize customer…' }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm permanent anonymization' });
    const confirm = within(dialog).getByRole('button', { name: 'Permanently anonymize' });
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByLabelText('Confirmation');
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: 'ANONYMIZE' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(mocks.mutations.anonymize).toEqual([{ customerId: 'customer_1' }]);
  });

  it('routes tag assignment through the named customer contract and announces success', () => {
    renderConsole();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Assign tag', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'tag_vip' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    expect(mocks.mutations.assignTag).toEqual([{ customerId: 'customer_1', tagId: 'tag_vip' }]);
    expect(screen.getByRole('status')).toHaveTextContent('Tag assigned.');
  });

  it('submits immutable program versions and append-only adjustments through loyalty contracts', () => {
    renderConsole();

    fireEvent.change(screen.getByLabelText('Effective from'), {
      target: { value: '2026-09-01T12:00' },
    });
    fireEvent.change(screen.getByLabelText('Earn rate'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Redemption value'), { target: { value: '0.01' } });
    fireEvent.change(screen.getByLabelText(/^Expiry days/), { target: { value: '365' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create program version' }));

    expect(mocks.mutations.configure[0]).toMatchObject({
      effectiveFrom: expect.any(String),
      earnRate: '2',
      redemptionValue: '0.01',
      expiryDays: 365,
    });

    fireEvent.change(screen.getByLabelText('Points'), { target: { value: '-20' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Service recovery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Append adjustment' }));

    expect(mocks.mutations.adjust[0]).toMatchObject({
      accountId: 'account_1',
      points: -20,
      reason: 'Service recovery',
      idempotencyKey: expect.any(String),
    });
  });
});
