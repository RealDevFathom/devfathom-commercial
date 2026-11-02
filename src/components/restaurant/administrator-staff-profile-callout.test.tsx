/**
 * WHA-1181 — the one-time repair for organizations activated before their
 * administrator was provisioned a `RestaurantStaffProfile`.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: null as {
    user?: { id?: string; organizationId?: string; role?: string };
  } | null,
  enabledModules: ['restaurant-core'] as string[],
  profileQuery: vi.fn(),
  provisionMutation: vi.fn(),
  invalidate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: mocks.session }) }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ enabledModules: mocks.enabledModules }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ invalidate: mocks.invalidate }),
    restaurantStaff: {
      mySelfProfile: { useQuery: mocks.profileQuery },
      provisionMyProfile: { useMutation: mocks.provisionMutation },
    },
  },
}));

import { AdministratorStaffProfileCallout } from './administrator-staff-profile-callout';

const cta = { name: 'Set up now' };

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.session = { user: { id: 'admin-a', organizationId: 'org-a', role: 'ADMIN' } };
  mocks.enabledModules = ['restaurant-core'];
  mocks.profileQuery.mockReturnValue({ data: { hasProfile: false, status: null } });
  mocks.provisionMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

afterEach(() => vi.restoreAllMocks());

describe('AdministratorStaffProfileCallout', () => {
  it('keeps a dismissed reminder hidden after remounting for the same administrator', () => {
    const view = render(<AdministratorStaffProfileCallout />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss staff profile reminder' }));
    expect(screen.queryByText('Set up your staff profile')).not.toBeInTheDocument();
    view.unmount();

    render(<AdministratorStaffProfileCallout />);
    expect(screen.queryByText('Set up your staff profile')).not.toBeInTheDocument();
  });

  it.each([
    { id: 'admin-b', organizationId: 'org-a' },
    { id: 'admin-a', organizationId: 'org-b' },
  ])('does not share dismissal with $id in $organizationId', (identity) => {
    const view = render(<AdministratorStaffProfileCallout />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss staff profile reminder' }));
    mocks.session = { user: { ...identity, role: 'ADMIN' } };

    view.rerender(<AdministratorStaffProfileCallout />);
    expect(screen.getByRole('button', cta)).toBeEnabled();
  });

  it('still dismisses for this mount when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    render(<AdministratorStaffProfileCallout />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss staff profile reminder' }));
    expect(screen.queryByText('Set up your staff profile')).not.toBeInTheDocument();
  });

  it('offers the setup step to an administrator of a restaurant workspace with no profile', () => {
    render(<AdministratorStaffProfileCallout />);

    expect(screen.getByText('Set up your staff profile')).toBeInTheDocument();
    expect(screen.getByRole('button', cta)).toBeEnabled();
    expect(mocks.profileQuery).toHaveBeenCalledWith(undefined, { enabled: true });
  });

  it('calls the shared provisioning mutation on click', () => {
    const mutate = vi.fn();
    mocks.provisionMutation.mockReturnValue({ mutate, isPending: false });

    render(<AdministratorStaffProfileCallout />);
    fireEvent.click(screen.getByRole('button', cta));

    expect(mutate).toHaveBeenCalledOnce();
  });

  it('disables and marks the button busy while the profile is being created', () => {
    mocks.provisionMutation.mockReturnValue({ mutate: vi.fn(), isPending: true });

    render(<AdministratorStaffProfileCallout />);
    const button = screen.getByRole('button', { name: 'Setting up…' });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('renders nothing once the profile exists', () => {
    mocks.profileQuery.mockReturnValue({ data: { hasProfile: true, status: 'ACTIVE' } });

    const { container } = render(<AdministratorStaffProfileCallout />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the check is still loading', () => {
    mocks.profileQuery.mockReturnValue({ data: undefined });

    const { container } = render(<AdministratorStaffProfileCallout />);

    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['a non-administrator', { user: { role: 'MEMBER' } }, ['restaurant-core']],
    ['an unauthenticated shell', null, ['restaurant-core']],
    ['a workspace without the restaurant-core grant', { user: { role: 'ADMIN' } }, ['projects']],
    ['a workspace with no module grants at all', { user: { role: 'ADMIN' } }, []],
  ])('renders nothing and issues no request for %s', (_label, session, enabledModules) => {
    mocks.session = session;
    mocks.enabledModules = enabledModules;

    const { container } = render(<AdministratorStaffProfileCallout />);

    expect(container).toBeEmptyDOMElement();
    expect(mocks.profileQuery).toHaveBeenCalledWith(undefined, { enabled: false });
  });

  it('reports success and refetches the queries that were being denied', async () => {
    render(<AdministratorStaffProfileCallout />);
    const { onSuccess } = mocks.provisionMutation.mock.calls[0]![0];

    await onSuccess();

    expect(mocks.success).toHaveBeenCalledWith('Your staff profile is ready.');
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });

  it('surfaces a failed repair instead of silently doing nothing', () => {
    render(<AdministratorStaffProfileCallout />);
    const { onError } = mocks.provisionMutation.mock.calls[0]![0];

    onError({ message: 'You do not have permission to perform this action.' });

    expect(mocks.error).toHaveBeenCalledWith('You do not have permission to perform this action.');
  });
});
