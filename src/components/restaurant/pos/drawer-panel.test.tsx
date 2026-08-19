import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DrawerPanel } from './drawer-panel';
import type { TerminalRequest, TerminalRequestOptions } from './checkout-panel';

describe('DrawerPanel', () => {
  it('opens, adjusts, and closes one in-memory drawer session', async () => {
    const calls: { path: string; options?: TerminalRequestOptions }[] = [];
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      if (path.endsWith('/open')) {
        return {
          drawerSessionId: 'drawer-1',
          businessDate: '2026-08-19',
          openingFloat: '100.00',
          replayed: false,
        } as T;
      }
      if (path.endsWith('/close')) {
        return {
          drawerSessionId: 'drawer-1',
          expectedCash: '90.00',
          countedCash: '90.00',
          variance: '0.00',
          replayed: false,
        } as T;
      }
      return {} as T;
    };

    render(<DrawerPanel request={request} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cash drawer' }));
    const dialog = screen.getByRole('dialog', { name: 'Cash drawer' });
    expect(within(dialog).getByText(/state exists only in this page memory/)).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText('Opening float'), {
      target: { value: '100.00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open drawer' }));
    await within(dialog).findByText('drawer-1');

    fireEvent.change(within(dialog).getByLabelText('Movement'), {
      target: { value: 'PAID_OUT' },
    });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '10.00' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Petty cash' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record movement' }));
    await within(dialog).findByText('Cash movement recorded.');

    fireEvent.change(within(dialog).getByLabelText('Counted cash'), {
      target: { value: '90.00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close drawer' }));
    await within(dialog).findByText('Drawer closed.');

    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map(({ path }) => path)).toEqual([
      '/api/restaurant/cash/drawer/open',
      '/api/restaurant/cash/drawer/movement',
      '/api/restaurant/cash/drawer/close',
    ]);
    expect(calls[1]?.options?.body).toEqual({
      drawerSessionId: 'drawer-1',
      kind: 'PAID_OUT',
      amount: '10.00',
      reason: 'Petty cash',
    });
    expect(calls[2]?.options?.body).toEqual({
      drawerSessionId: 'drawer-1',
      countedCash: '90.00',
    });
  });

  it('blocks every dismissal path while a drawer mutation is pending', async () => {
    let resolveOpen!: (value: {
      drawerSessionId: string;
      businessDate: string;
      openingFloat: string;
      replayed: boolean;
    }) => void;
    const pendingOpen = new Promise<{
      drawerSessionId: string;
      businessDate: string;
      openingFloat: string;
      replayed: boolean;
    }>((resolve) => {
      resolveOpen = resolve;
    });
    const requestMock = vi.fn(async (path: string, options?: TerminalRequestOptions) => {
      void path;
      void options;
      return pendingOpen;
    });
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) =>
      (await requestMock(path, options)) as T;

    render(<DrawerPanel request={request} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cash drawer' }));
    const dialog = screen.getByRole('dialog', { name: 'Cash drawer' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open drawer' }));

    expect(within(dialog).getByRole('button', { name: 'Close drawer panel' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);
    expect(screen.getByRole('dialog', { name: 'Cash drawer' })).toBeVisible();

    await act(async () =>
      resolveOpen({
        drawerSessionId: 'drawer-1',
        businessDate: '2026-08-19',
        openingFloat: '0.00',
        replayed: false,
      })
    );
    expect(await within(dialog).findByText('drawer-1')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close drawer panel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Cash drawer' })).not.toBeInTheDocument()
    );
  });
});
