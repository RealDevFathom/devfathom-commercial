import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression (hotel and pharmacy packages, no `hr` module): Settings → Profile → Edit did
// nothing because `team.getById` answered 403 and the card neither showed the refusal nor
// disabled the control. Errors on this card must never be silent.
type MutationOptions = {
  onSuccess?: () => void;
  onError?: (error: { message: string; data?: { code?: string } }) => void;
};

const mocks = vi.hoisted(() => ({
  session: { user: { id: 'user_1', organizationId: 'org_1', name: 'Hotel General Manager' } },
  profile: {
    data: undefined as unknown,
    error: null as null | { message: string; data?: { code?: string } },
    isLoading: false,
  },
  updateOptions: undefined as MutationOptions | undefined,
  updateMutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mocks.session, status: 'authenticated' }),
  signOut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ team: { getById: { invalidate: mocks.invalidate } } }),
    team: {
      getById: { useQuery: () => mocks.profile },
      updateProfile: {
        useMutation: (options: MutationOptions) => {
          mocks.updateOptions = options;
          return { mutate: mocks.updateMutate, isPending: false };
        },
      },
    },
  },
}));

import { ProfileSection } from './settings-content';

const loaded = {
  id: 'user_1',
  name: 'Hotel General Manager',
  title: 'General Manager',
  phone: null,
  bio: null,
  skills: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.profile = { data: undefined, error: null, isLoading: false };
  mocks.updateOptions = undefined;
});

describe('ProfileSection', () => {
  it('shows the refusal and disables Edit when the profile cannot be read', () => {
    mocks.profile = {
      data: undefined,
      error: {
        message: 'The HR module is not enabled for this organization.',
        data: { code: 'FORBIDDEN' },
      },
      isLoading: false,
    };
    render(<ProfileSection />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your profile could not be loaded, so it cannot be edited yet. The HR module is not enabled for this organization.'
    );
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('withholds Edit while the profile is still loading', () => {
    mocks.profile = { data: undefined, error: null, isLoading: true };
    render(<ProfileSection />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the editor from the loaded profile and saves through updateProfile', () => {
    mocks.profile = { data: loaded, error: null, isLoading: false };
    render(<ProfileSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Hotel General Manager');
    fireEvent.change(name, { target: { value: 'Hotel GM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      name: 'Hotel GM',
      phone: null,
      bio: null,
      skills: [],
    });
  });

  it('keeps the editor open and shows the reason when a save is refused', async () => {
    mocks.profile = { data: loaded, error: null, isLoading: false };
    render(<ProfileSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    mocks.updateOptions?.onError?.({
      message: 'The HR module is not enabled for this organization.',
      data: { code: 'FORBIDDEN' },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Your profile was not saved. The HR module is not enabled for this organization.'
      )
    );
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});
