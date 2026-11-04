import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { useAssistant } from '@/lib/assistant-store';
import type { AskFathomAvailability as Settings } from '@/lib/ai/ask-fathom-settings';

const mocks = vi.hoisted(() => ({
  session: { status: 'authenticated', data: { user: { organizationId: 'org-a', role: 'ADMIN' } } },
  settings: {
    data: {
      organizationId: 'org-a',
      askFathomEnabled: true,
      available: true,
      unavailableReason: null,
    } as Settings | undefined,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  query: vi.fn(),
  mutateAsync: vi.fn(),
  cancel: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ useSession: () => mocks.session }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      organizationAdmin: {
        askFathomSettings: {
          cancel: mocks.cancel,
          setData: mocks.setData,
          invalidate: mocks.invalidate,
        },
      },
    }),
    organizationAdmin: {
      askFathomSettings: { useQuery: mocks.query },
      setAskFathomEnabled: { useMutation: () => ({ mutateAsync: mocks.mutateAsync }) },
    },
  },
}));

import { OrganizationAskFathomSettings } from './organization-admin-content';

function settingsFor(organizationId: string, askFathomEnabled: boolean): Settings {
  return {
    organizationId,
    askFathomEnabled,
    available: askFathomEnabled,
    unavailableReason: askFathomEnabled ? null : 'COMPANY_DISABLED',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = {
    status: 'authenticated',
    data: { user: { organizationId: 'org-a', role: 'ADMIN' } },
  };
  mocks.settings = {
    data: settingsFor('org-a', true),
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  mocks.query.mockImplementation(() => mocks.settings);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.setData.mockImplementation((_input, data) => {
    mocks.settings.data = data;
  });
  useAssistant.setState(useAssistant.getInitialState());
  useAssistant.getState().setOrganization('org-a');
  useAssistant.getState().confirmSettings(mocks.settings.data!, 1);
});
afterEach(cleanup);

describe('organization Ask Fathom chat control', () => {
  it.each(['HR', 'EMPLOYEE', 'PHARMACIST'])('does not expose settings or fetch as %s', (role) => {
    mocks.session.data.user.role = role;
    render(<OrganizationAskFathomSettings />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not expose settings while the session is unresolved', () => {
    mocks.session.status = 'loading';
    render(<OrganizationAskFathomSettings />);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('preserves a failed manual change, retries, cancels old query before installing confirmed data', async () => {
    mocks.mutateAsync
      .mockRejectedValueOnce(new Error('Save failed'))
      .mockResolvedValueOnce(settingsFor('org-a', false));
    render(<OrganizationAskFathomSettings />);
    expect(screen.getByText(/Reports, Insights, and other enabled/)).toBeInTheDocument();
    const control = screen.getByRole('switch', { name: 'Enable Ask Fathom chat' });
    fireEvent.click(control);
    fireEvent.click(screen.getByRole('button', { name: 'Save chat setting' }));
    await screen.findByRole('alert');
    expect(control).not.toBeChecked();
    expect(useAssistant.getState().askFathomEnabled).toBe(true);
    expect(mocks.setData).not.toHaveBeenCalled();
    expect(mocks.mutateAsync).toHaveBeenLastCalledWith({ askFathomEnabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByText('Chat setting saved.');
    expect(useAssistant.getState().askFathomEnabled).toBe(false);
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setData.mock.invocationCallOrder[0]
    );
    expect(mocks.setData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0]
    );
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    // A render effect holding pre-save query data cannot re-enable chat.
    act(() => useAssistant.getState().confirmSettings(settingsFor('org-a', true), 1));
    expect(useAssistant.getState().askFathomEnabled).toBe(false);
  });

  it.each(['loading', 'error', 'mismatch'])(
    'disables an unconfirmed %s setting and supports reload',
    (state) => {
      if (state === 'loading') {
        mocks.settings.data = undefined;
        mocks.settings.isFetching = true;
      }
      if (state === 'error') mocks.settings.isError = true;
      if (state === 'mismatch') mocks.settings.data!.organizationId = 'org-b';
      render(<OrganizationAskFathomSettings />);
      expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('button', { name: 'Save chat setting' })).toBeDisabled();
      const retry = screen.getByRole('button', { name: 'Retry settings' });
      if (state === 'loading') expect(retry).toBeDisabled();
      else {
        fireEvent.click(retry);
        expect(mocks.settings.refetch).toHaveBeenCalledOnce();
      }
      expect(mocks.mutateAsync).not.toHaveBeenCalled();
    }
  );

  it('does not install a mutation response after the administrator changes organizations', async () => {
    let finish!: (data: Settings) => void;
    mocks.mutateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = render(<OrganizationAskFathomSettings />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Save chat setting' }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
    mocks.session.data.user.organizationId = 'org-b';
    act(() => useAssistant.getState().setOrganization('org-b'));
    view.rerender(<OrganizationAskFathomSettings />);
    await act(async () => finish(settingsFor('org-a', false)));
    await waitFor(() => expect(mocks.setData).not.toHaveBeenCalled());
    expect(useAssistant.getState().organizationId).toBe('org-b');
  });

  it('cancels a real query cache request so its late enabled response cannot undo a saved disable', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ['organizationAdmin', 'askFathomSettings'];
    let respond!: (data: Settings) => void;
    client.setQueryData(queryKey, mocks.settings.data);
    const oldRequest = client
      .fetchQuery({
        queryKey,
        queryFn: () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      })
      .catch(() => undefined);
    mocks.cancel.mockImplementation(() => client.cancelQueries({ queryKey }));
    mocks.setData.mockImplementation((_input, data) => {
      client.setQueryData(queryKey, data);
      mocks.settings.data = data;
    });
    mocks.mutateAsync.mockResolvedValue(settingsFor('org-a', false));
    render(<OrganizationAskFathomSettings />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Save chat setting' }));
    await screen.findByText('Chat setting saved.');
    await act(async () => {
      respond(settingsFor('org-a', true));
      await oldRequest;
    });
    expect(client.getQueryData(queryKey)).toEqual(settingsFor('org-a', false));
    expect(useAssistant.getState().askFathomEnabled).toBe(false);
    client.clear();
  });
});
