import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryState = {
  data?: unknown;
  isLoading?: boolean;
  isSuccess?: boolean;
  error?: (Error & { data?: { code?: string } }) | null;
};

const mocks = vi.hoisted(() => ({
  access: {} as QueryState,
  workspace: {} as QueryState,
  workspaceOptions: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyPrescriptions: { workspace: { invalidate: vi.fn() } } }),
    pharmacyPrescriptions: {
      captureAccess: { useQuery: () => mocks.access },
      workspace: {
        useQuery: (_input: unknown, options: unknown) => {
          mocks.workspaceOptions(options);
          return mocks.workspace;
        },
      },
      capture: { useMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }) },
      uploadSource: { useMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }) },
      captureRefillReminder: {
        useMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false, error: null }),
      },
    },
  },
}));

import { PrescriptionsConsole } from './prescriptions-console';

const forbidden = (message = 'Prescription file access is not permitted.') =>
  Object.assign(new Error(message), { data: { code: 'FORBIDDEN' } });
const workspaceData = {
  branches: [],
  selectedBranchId: null,
  patients: [],
  prescribers: [],
  medicines: [],
  prescriptions: [],
  reminderCaptures: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access = { data: { allowed: true }, isSuccess: true, error: null };
  mocks.workspace = { data: workspaceData, isSuccess: true, error: null };
});

describe('prescriptions page capture access (#238)', () => {
  it.each([
    ['refuses capture', () => ({ data: { allowed: false }, isSuccess: true, error: null })],
    ['is forbidden', () => ({ isSuccess: false, error: forbidden('Module not enabled.') })],
  ])('shows a cashier no capture form when the server %s', (_label, access) => {
    mocks.access = access();
    mocks.workspace = { isSuccess: false, error: null };
    render(<PrescriptionsConsole />);
    expect(
      screen.getByRole('heading', { name: 'Prescription capture needs a pharmacist' })
    ).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Capture prescription' })).toBeNull();
    expect(screen.queryByLabelText(/^Prescription image/)).toBeNull();
    // The protected workspace is never requested for this user.
    expect(mocks.workspaceOptions).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByText(/connection is restored/)).toBeNull();
  });

  it('drops the form if the workspace is refused after access was granted', () => {
    mocks.workspace = { data: workspaceData, isSuccess: false, error: forbidden() };
    render(<PrescriptionsConsole />);
    expect(
      screen.getByRole('heading', { name: 'Prescription capture needs a pharmacist' })
    ).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Capture prescription' })).toBeNull();
  });

  it('shows the capture form to someone the server allows', () => {
    render(<PrescriptionsConsole />);
    expect(mocks.workspaceOptions).toHaveBeenLastCalledWith({ enabled: true });
    expect(screen.getByRole('form', { name: 'Capture prescription' })).toBeVisible();
    expect(screen.getByLabelText(/^Prescription image/)).toBeVisible();
    expect(screen.queryByText(/needs the pharmacist dispensing permission/)).toBeNull();
  });

  it('checks access before anything else, and says when it cannot', () => {
    mocks.access = { isLoading: true, isSuccess: false, error: null };
    const view = render(<PrescriptionsConsole />);
    expect(screen.getByRole('heading', { name: 'Checking prescription access' })).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Capture prescription' })).toBeNull();
    mocks.access = {
      isSuccess: false,
      error: Object.assign(new Error('fetch failed'), { data: { code: 'INTERNAL_SERVER_ERROR' } }),
    };
    view.rerender(<PrescriptionsConsole />);
    expect(
      screen.getByRole('heading', { name: 'Prescription access could not be checked' })
    ).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Capture prescription' })).toBeNull();
  });
});
