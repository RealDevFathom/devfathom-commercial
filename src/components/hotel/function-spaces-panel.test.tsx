import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRouter } from '@/server/routers/_app';

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  deactivate: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/trpc', async () => {
  const { useState } = await import('react');
  type Options = {
    onSuccess: () => unknown;
    onError: (error: Error, variables: Record<string, unknown>) => void;
  };
  function mutation(name: 'create' | 'update' | 'deactivate') {
    return {
      useMutation: function useMutation(options: Options) {
        const [isPending, setPending] = useState(false);
        return {
          isPending,
          mutate(variables: Record<string, unknown>) {
            setPending(true);
            void api[name](variables)
              .then(() => options.onSuccess())
              .catch((error: Error) => options.onError(error, variables))
              .finally(() => setPending(false));
          },
        };
      },
    };
  }
  return {
    trpc: {
      useUtils: () => ({ hotelProperty: { spaces: { list: { fetch: api.fetch } } } }),
      hotelProperty: {
        spaces: {
          create: mutation('create'),
          update: mutation('update'),
          deactivate: mutation('deactivate'),
        },
      },
    },
  };
});

import { HotelFunctionSpacesPanel } from './function-spaces-panel';

const space = {
  id: 'crystal',
  organizationId: 'org',
  branchId: 'property',
  name: 'Crystal Hall',
  nameUr: null,
  layouts: [{ layout: 'Theatre', capacity: 300 }],
  pricing: {},
  setupMinutes: 30,
  teardownMinutes: 15,
  active: true,
  maxCapacity: 300,
};
const initial = { branchId: 'property', spaces: [space] };

beforeEach(() => {
  vi.resetAllMocks();
  api.create.mockResolvedValue({});
  api.update.mockResolvedValue({});
  api.deactivate.mockResolvedValue({});
  api.fetch.mockResolvedValue(initial);
});
afterEach(cleanup);

function edit() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  return screen.getByRole('form', { name: 'Edit Crystal Hall' });
}

describe('function space operator states', () => {
  it('refreshes a populated query cache after retirement so a later edit cannot reactivate it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60 * 1000, retry: false } },
    });
    let serverSpace = { ...space };
    let reads = 0;
    const client = createTRPCClient<AppRouter>({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              let data;
              if (op.type === 'query') {
                reads++;
                data = { ...initial, spaces: [{ ...serverSpace }] };
              } else if (op.path === 'hotelProperty.spaces.deactivate') {
                serverSpace = { ...serverSpace, active: false };
                data = { id: serverSpace.id, active: false };
              } else {
                const input = op.input as { name: string; active: boolean };
                serverSpace = { ...serverSpace, name: input.name, active: input.active };
                data = { id: serverSpace.id };
              }
              observer.next({ result: { data } });
              observer.complete();
            }),
      ],
    });
    const utils = createTRPCQueryUtils({ client, queryClient });
    api.fetch.mockImplementation(utils.hotelProperty.spaces.list.fetch);
    api.update.mockImplementation(client.hotelProperty.spaces.update.mutate);
    api.deactivate.mockImplementation(client.hotelProperty.spaces.deactivate.mutate);

    try {
      render(<HotelFunctionSpacesPanel initial={initial} />);
      // First successful edit populates the real cache, just as the live panel does.
      fireEvent.submit(edit());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled());
      expect(reads).toBe(1);
      // A normal fetch still reuses this fresh cache under the provider policy.
      await utils.hotelProperty.spaces.list.fetch();
      expect(reads).toBe(1);

      fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled());
      expect(reads).toBe(2);
      expect(screen.getByText('Retired')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();

      fireEvent.submit(edit());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled());
      expect(api.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
      expect(serverSpace.active).toBe(false);
      expect(screen.getByText('Retired')).toBeVisible();
      expect(reads).toBe(3);
    } finally {
      queryClient.clear();
    }
  });

  it('keeps generic edit errors inside the edit form and preserves entered values', async () => {
    api.update.mockRejectedValue(new Error('Those buffers overlap existing bookings.'));
    render(<HotelFunctionSpacesPanel initial={initial} />);
    const form = edit();
    fireEvent.change(within(form).getByLabelText('Space name'), {
      target: { value: 'Crystal Ballroom' },
    });
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent('Those buffers overlap');
    expect(within(form).getByLabelText('Space name')).toHaveValue('Crystal Ballroom');
    expect(
      within(screen.getByRole('form', { name: 'Add a function space' })).queryByRole('alert')
    ).toBeNull();
  });

  it('associates validation errors with only the edited inputs, including every price', async () => {
    api.update.mockRejectedValue({
      message: 'Invalid input',
      data: { validation: { name: ['Use a longer name.'], pricing: ['Use whole minor units.'] } },
    });
    render(<HotelFunctionSpacesPanel initial={initial} />);
    const form = edit();
    fireEvent.submit(form);
    await within(form).findByText('Use a longer name.');
    for (const label of [
      'Space name',
      'Hourly rate (PKR)',
      'Daily rate (PKR)',
      'Per function (PKR)',
      'Minimum spend (PKR)',
    ]) {
      const input = within(form).getByLabelText(label);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(document.getElementById(input.getAttribute('aria-describedby')!)).toHaveAttribute(
        'role',
        'alert'
      );
    }
    const add = screen.getByRole('form', { name: 'Add a function space' });
    expect(within(add).getByLabelText('Space name')).toHaveAttribute('aria-invalid', 'false');
  });

  it('preserves retired status when saving an edit', async () => {
    render(
      <HotelFunctionSpacesPanel initial={{ ...initial, spaces: [{ ...space, active: false }] }} />
    );
    fireEvent.submit(edit());
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'crystal', active: false })
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Edit Crystal Hall' })).toBeNull()
    );
  });

  it('keeps actions disabled during save and refresh, exposes refresh failure, and retries only the read', async () => {
    let finishSave!: () => void;
    let failRefresh!: (error: Error) => void;
    api.update.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSave = resolve;
      })
    );
    api.fetch.mockReturnValueOnce(
      new Promise((_, reject) => {
        failRefresh = reject;
      })
    );
    render(<HotelFunctionSpacesPanel initial={initial} />);
    const form = edit();
    fireEvent.submit(form);
    expect(within(form).getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(form).getByLabelText('Space name')).toBeDisabled();
    await act(async () => {
      finishSave();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing spaces');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    await act(async () => {
      failRefresh(new Error('Network unavailable'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Your change was saved');
    expect(screen.getByRole('button', { name: 'Add space' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('requires retirement confirmation, supports cancellation, and shows local retirement failures', async () => {
    api.deactivate.mockRejectedValue(new Error('Retirement failed. Try again.'));
    render(<HotelFunctionSpacesPanel initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    expect(api.deactivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep space active' }));
    expect(screen.queryByRole('group', { name: 'Retire Crystal Hall' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement' }));
    const confirmation = screen.getByRole('group', { name: 'Retire Crystal Hall' });
    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('Retirement failed');
    expect(api.deactivate).toHaveBeenCalledExactlyOnceWith({ spaceId: 'crystal' });
    expect(
      within(screen.getByRole('form', { name: 'Add a function space' })).queryByRole('alert')
    ).toBeNull();
    fireEvent.keyDown(confirmation, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Retire Crystal Hall' })).toBeNull();
  });

  it('creates from the empty state and clears the form only after saving', async () => {
    render(<HotelFunctionSpacesPanel initial={{ ...initial, spaces: [] }} />);
    expect(screen.getByText(/no function spaces yet/)).toBeVisible();
    const form = screen.getByRole('form', { name: 'Add a function space' });
    fireEvent.change(within(form).getByLabelText('Space name'), {
      target: { value: 'Crystal Hall' },
    });
    fireEvent.change(within(form).getByLabelText('Layouts and capacities'), {
      target: { value: 'Theatre 300' },
    });
    fireEvent.change(within(form).getByLabelText('Hourly rate (PKR)'), {
      target: { value: '12.50' },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
          pricing: expect.objectContaining({ hourlyMinor: 1250 }),
        })
      )
    );
    await waitFor(() => expect(within(form).getByLabelText('Space name')).toHaveValue(''));
  });
});
