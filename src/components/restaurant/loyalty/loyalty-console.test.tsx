import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => {
  const query = <T,>(data: T) => ({
    data,
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  });
  const mutation = () => ({
    mutateAsync: vi.fn(async (input: unknown): Promise<unknown> => {
      void input;
      return {};
    }),
    reset: vi.fn(),
    isPending: false,
    isSuccess: false,
    error: null as unknown,
  });
  return {
    customerList: query({
      customers: [
        {
          id: 'cust_1',
          displayName: 'Ada Lovelace',
          givenName: 'Ada',
          familyName: 'Lovelace',
          birthDate: null,
          notes: null,
          anonymizedAt: null,
          createdAt: '2026-08-01T10:00:00.000Z',
          updatedAt: '2026-08-10T10:00:00.000Z',
          identifiers: [
            {
              id: 'ident_1',
              kind: 'EMAIL',
              normalizedValue: 'ada@example.com',
              verifiedAt: null,
              createdAt: '2026-08-01T10:00:00.000Z',
              updatedAt: '2026-08-01T10:00:00.000Z',
            },
          ],
          tags: [{ id: 'tag_1', name: 'VIP', color: null, assignedAt: '2026-08-01T10:00:00.000Z' }],
        },
      ],
      nextCursor: null,
    }),
    customerDetail: query({
      id: 'cust_1',
      displayName: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      birthDate: '1990-12-10T00:00:00.000Z',
      notes: 'Prefers window seating',
      anonymizedAt: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-10T10:00:00.000Z',
      identifiers: [
        {
          id: 'ident_1',
          kind: 'EMAIL',
          normalizedValue: 'ada@example.com',
          verifiedAt: '2026-08-02T10:00:00.000Z',
          createdAt: '2026-08-01T10:00:00.000Z',
          updatedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
      interactions: [
        {
          id: 'inter_1',
          branchId: 'branch_1',
          branch: { id: 'branch_1', name: 'Downtown' },
          orderId: 'order_1',
          type: 'DINE_IN',
          occurredAt: '2026-08-09T19:00:00.000Z',
          createdAt: '2026-08-09T19:00:00.000Z',
        },
      ],
      orders: [],
      tags: [{ id: 'tag_1', name: 'VIP', color: null, assignedAt: '2026-08-01T10:00:00.000Z' }],
      consentEvents: [
        {
          id: 'consent_1',
          channel: 'EMAIL',
          granted: true,
          source: 'web-signup',
          actorId: 'user_1',
          policyVersion: '2026-01',
          occurredAt: '2026-08-01T10:00:00.000Z',
          idempotencyKey: 'ck_1',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'consent_2',
          channel: 'SMS',
          granted: false,
          source: 'pos',
          actorId: 'user_1',
          policyVersion: '2026-01',
          occurredAt: '2026-08-01T11:00:00.000Z',
          idempotencyKey: 'ck_2',
          createdAt: '2026-08-01T11:00:00.000Z',
        },
      ],
      currentConsent: {
        EMAIL: {
          id: 'consent_1',
          channel: 'EMAIL',
          granted: true,
          source: 'web-signup',
          actorId: 'user_1',
          policyVersion: '2026-01',
          occurredAt: '2026-08-01T10:00:00.000Z',
          idempotencyKey: 'ck_1',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        SMS: {
          id: 'consent_2',
          channel: 'SMS',
          granted: false,
          source: 'pos',
          actorId: 'user_1',
          policyVersion: '2026-01',
          occurredAt: '2026-08-01T11:00:00.000Z',
          idempotencyKey: 'ck_2',
          createdAt: '2026-08-01T11:00:00.000Z',
        },
      },
      loyaltySummary: {
        id: 'acct_1',
        active: true,
        enrolledAt: '2026-08-01T10:00:00.000Z',
        deactivatedAt: null,
        balance: 420,
      },
    }),
    programList: query([
      {
        id: 'prog_1',
        versionNumber: 2,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        earnRate: '1.5',
        redemptionValue: '0.01',
        expiryDays: 365,
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ]),
    accountList: query([
      {
        id: 'acct_1',
        customerId: 'cust_1',
        active: true,
        enrolledAt: '2026-08-01T10:00:00.000Z',
        deactivatedAt: null,
        balance: 420,
        customer: { id: 'cust_1', displayName: 'Ada Lovelace', anonymizedAt: null },
      },
    ]),
    ledgerList: query([
      {
        id: 'entry_1',
        accountId: 'acct_1',
        programVersionId: 'prog_1',
        kind: 'EARN',
        points: 120,
        billId: 'bill_1',
        refundId: null,
        reversesEntryId: null,
        actorId: null,
        reason: null,
        expiresAt: null,
        occurredAt: '2026-08-05T20:00:00.000Z',
        idempotencyKey: 'lk_1',
        createdAt: '2026-08-05T20:00:00.000Z',
        programVersion: {
          id: 'prog_1',
          versionNumber: 2,
          effectiveFrom: '2026-08-01T00:00:00.000Z',
          earnRate: '1.5',
          redemptionValue: '0.01',
          expiryDays: 365,
          createdAt: '2026-07-20T00:00:00.000Z',
        },
      },
      {
        id: 'entry_2',
        accountId: 'acct_1',
        programVersionId: 'prog_1',
        kind: 'REDEEM',
        points: -50,
        billId: 'bill_2',
        refundId: null,
        reversesEntryId: null,
        actorId: 'user_1',
        reason: 'Reward redemption',
        expiresAt: null,
        occurredAt: '2026-08-06T20:00:00.000Z',
        idempotencyKey: 'lk_2',
        createdAt: '2026-08-06T20:00:00.000Z',
        programVersion: {
          id: 'prog_1',
          versionNumber: 2,
          effectiveFrom: '2026-08-01T00:00:00.000Z',
          earnRate: '1.5',
          redemptionValue: '0.01',
          expiryDays: 365,
          createdAt: '2026-07-20T00:00:00.000Z',
        },
      },
    ]),
    exportMutation: mutation(),
    anonymizeMutation: mutation(),
    configureMutation: mutation(),
    adjustMutation: mutation(),
    calls: {
      customerList: [] as Array<{ input: unknown; enabled: boolean }>,
      customerDetail: [] as Array<{ input: unknown; enabled: boolean }>,
      programList: [] as Array<{ input: unknown; enabled: boolean }>,
      accountList: [] as Array<{ input: unknown; enabled: boolean }>,
      ledgerList: [] as Array<{ input: unknown; enabled: boolean }>,
    },
  };
});

function hook<T>(
  query: T,
  calls: Array<{ input: unknown; enabled: boolean }>,
  input: unknown,
  options: { enabled: boolean }
) {
  calls.push({ input, enabled: options.enabled });
  return query;
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantCustomers: {
      list: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.customerList, mocks.calls.customerList, input, options),
      },
      detail: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.customerDetail, mocks.calls.customerDetail, input, options),
      },
      export: { useMutation: () => mocks.exportMutation },
      anonymize: { useMutation: () => mocks.anonymizeMutation },
    },
    restaurantLoyalty: {
      listPrograms: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.programList, mocks.calls.programList, input, options),
      },
      listAccounts: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.accountList, mocks.calls.accountList, input, options),
      },
      listLedger: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.ledgerList, mocks.calls.ledgerList, input, options),
      },
      configure: { useMutation: () => mocks.configureMutation },
      adjust: { useMutation: () => mocks.adjustMutation },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { LoyaltyConsole } from './loyalty-console';

function entitlements(modules: string[]): EntitlementView {
  const all = ['restaurant-customers', 'restaurant-loyalty'];
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: modules,
    modules: all.map((key) => ({
      key,
      name: key,
      enabled: modules.includes(key),
      source: modules.includes(key) ? ('OVERRIDE' as const) : ('NONE' as const),
      seatLimit: null,
      expiresAt: null,
    })),
    limits: {},
  };
}

function renderConsole(modules: string[] = ['restaurant-customers', 'restaurant-loyalty']) {
  return render(
    <EntitlementsProvider value={entitlements(modules)}>
      <LoyaltyConsole />
    </EntitlementsProvider>
  );
}

function openLoyalty() {
  fireEvent.click(screen.getByRole('tab', { name: 'Loyalty' }));
}

describe('LoyaltyConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mocks.calls).forEach((calls) => {
      calls.length = 0;
    });
    [
      mocks.customerList,
      mocks.customerDetail,
      mocks.programList,
      mocks.accountList,
      mocks.ledgerList,
    ].forEach((query) => {
      query.error = null;
      query.isLoading = false;
    });
    [
      mocks.exportMutation,
      mocks.anonymizeMutation,
      mocks.configureMutation,
      mocks.adjustMutation,
    ].forEach((mutation) => {
      mutation.error = null;
      mutation.isPending = false;
      mutation.isSuccess = false;
      mutation.mutateAsync.mockClear();
      mutation.reset.mockClear();
    });
  });

  it('shows the customers disabled state without the module entitlement', () => {
    renderConsole([]);
    expect(screen.getByText('Customers module disabled')).toBeInTheDocument();
    expect(mocks.calls.customerList).toHaveLength(0);
  });

  it('shows the loyalty disabled state without the module entitlement', () => {
    renderConsole([]);
    openLoyalty();
    expect(screen.getByText('Loyalty module disabled')).toBeInTheDocument();
    expect(mocks.calls.programList).toHaveLength(0);
  });

  it('lists customers and passes the trimmed search query to the read', () => {
    renderConsole();
    expect(mocks.calls.customerList.at(-1)?.input).toEqual({ limit: 50 });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: '  ada ' } });
    expect(mocks.calls.customerList.at(-1)?.input).toEqual({ query: 'ada', limit: 50 });
  });

  it('exposes named controls and keyboard-focusable table overflow', () => {
    renderConsole();
    expect(screen.getByRole('heading', { level: 1, name: 'Customers & Loyalty' })).toBeVisible();
    expect(screen.getByRole('tablist', { name: 'Customers and loyalty' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search customers' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Customers table' })).toHaveAttribute(
      'tabindex',
      '0'
    );
  });

  it('renders identifiers, consent current-state, and loyalty balance on selection', () => {
    renderConsole();
    expect(mocks.calls.customerDetail.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(mocks.calls.customerDetail.at(-1)).toEqual({
      input: { customerId: 'cust_1' },
      enabled: true,
    });
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    // Current consent: EMAIL granted, SMS denied, PHONE/WHATSAPP/PUSH missing.
    expect(screen.getAllByText('Granted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Denied').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No record').length).toBe(3);
    expect(screen.getByText('420')).toBeInTheDocument();
    expect(screen.getByText('Downtown')).toBeInTheDocument();
  });

  it('exports a customer JSON bundle', async () => {
    const createObjectURL = vi.fn(() => 'blob:loyalty');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    mocks.exportMutation.mutateAsync.mockResolvedValueOnce({ profile: { id: 'cust_1' } });

    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export customer data bundle' }));

    await waitFor(() => expect(mocks.exportMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.exportMutation.mutateAsync).toHaveBeenCalledWith({ customerId: 'cust_1' });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    vi.unstubAllGlobals();
  });

  it('requires a destructive confirmation before anonymizing', async () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(mocks.anonymizeMutation.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Anonymize customer' }));
    expect(screen.getByRole('heading', { name: 'Anonymize this customer?' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Anonymize permanently' }));
    await waitFor(() => expect(mocks.anonymizeMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.anonymizeMutation.mutateAsync).toHaveBeenCalledWith({ customerId: 'cust_1' });
  });

  it('renders a retryable generic error and a no-retry permission-denied state', () => {
    mocks.customerList.error = { message: 'Boom', data: { code: 'INTERNAL_SERVER_ERROR' } };
    const first = renderConsole();
    expect(screen.getByText('Could not load customers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.customerList.refetch).toHaveBeenCalledOnce();
    first.unmount();

    mocks.customerList.error = { message: 'No', data: { code: 'FORBIDDEN' } };
    renderConsole();
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('renders the customer loading state', () => {
    mocks.customerList.isLoading = true;
    renderConsole();
    expect(screen.getByRole('status', { name: 'Loading customers' })).toBeInTheDocument();
  });

  it('lists immutable loyalty program versions', () => {
    renderConsole();
    openLoyalty();
    expect(mocks.calls.programList.at(-1)?.input).toEqual({ limit: 100 });
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('1.5')).toBeInTheDocument();
    expect(screen.getByText(/Effective versions are immutable/)).toBeInTheDocument();
  });

  it('submits a new program version with an ISO effective instant', async () => {
    renderConsole();
    openLoyalty();
    fireEvent.change(screen.getByLabelText('Effective from'), {
      target: { value: '2026-09-01T00:00' },
    });
    fireEvent.change(screen.getByLabelText('Earn rate'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Redemption value'), { target: { value: '0.02' } });
    fireEvent.change(screen.getByLabelText('Expiry days'), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create version' }));

    await waitFor(() => expect(mocks.configureMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.configureMutation.mutateAsync).toHaveBeenCalledWith({
      effectiveFrom: new Date('2026-09-01T00:00').toISOString(),
      earnRate: '2',
      redemptionValue: '0.02',
      expiryDays: 180,
    });
  });

  it('renders mutation pending, success, and error feedback', () => {
    mocks.configureMutation.isPending = true;
    const pending = renderConsole();
    openLoyalty();
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    pending.unmount();

    mocks.configureMutation.isPending = false;
    mocks.configureMutation.isSuccess = true;
    const success = renderConsole();
    openLoyalty();
    expect(screen.getByRole('status')).toHaveTextContent('New program version created.');
    success.unmount();

    mocks.configureMutation.isSuccess = false;
    mocks.configureMutation.error = { message: 'Rejected', data: { code: 'BAD_REQUEST' } };
    renderConsole();
    openLoyalty();
    expect(screen.getByRole('alert')).toHaveTextContent('Rejected');
  });

  it('reads the append-only ledger for a selected account and records an adjustment', async () => {
    renderConsole();
    openLoyalty();
    fireEvent.click(screen.getByRole('tab', { name: 'Accounts & ledger' }));
    expect(mocks.calls.accountList.at(-1)?.input).toEqual({ limit: 100 });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(mocks.calls.ledgerList.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'View ledger' }));
    expect(mocks.calls.ledgerList.at(-1)).toEqual({
      input: { accountId: 'acct_1', limit: 100 },
      enabled: true,
    });
    expect(screen.getByText('EARN')).toBeInTheDocument();
    expect(screen.getByText('REDEEM')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('-50')).toBeInTheDocument();
    expect(screen.getByText('Ledger & redemption history')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Adjustment points'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Adjustment reason'), {
      target: { value: 'Goodwill' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    await waitFor(() => expect(mocks.adjustMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.adjustMutation.mutateAsync).toHaveBeenCalledWith({
      accountId: 'acct_1',
      points: 50,
      reason: 'Goodwill',
      idempotencyKey: expect.any(String),
    });
  });

  it('shows the empty ledger state for an account with no entries', () => {
    mocks.ledgerList.data = [];
    renderConsole();
    openLoyalty();
    fireEvent.click(screen.getByRole('tab', { name: 'Accounts & ledger' }));
    fireEvent.click(screen.getByRole('button', { name: 'View ledger' }));
    expect(screen.getByText('No ledger entries')).toBeInTheDocument();
  });

  it('disables the adjustment submit until points and reason are valid', () => {
    renderConsole();
    openLoyalty();
    fireEvent.click(screen.getByRole('tab', { name: 'Accounts & ledger' }));
    fireEvent.click(screen.getByRole('button', { name: 'View ledger' }));
    expect(screen.getByRole('button', { name: 'Record adjustment' })).toBeDisabled();
  });
});
