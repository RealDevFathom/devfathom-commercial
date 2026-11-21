import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DrawerPanel } from './drawer-panel';
import type { TerminalRequest, TerminalRequestOptions } from './checkout-panel';

const activeDrawer = {
  drawerSessionId: 'drawer-1',
  businessDate: '2026-08-19',
  openingFloat: '100.00',
  replayed: false,
};

function mockRequest() {
  const requestMock = vi.fn<(path: string, options?: TerminalRequestOptions) => Promise<unknown>>();
  const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) =>
    (await requestMock(path, options)) as T;
  return { requestMock, request };
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Cash drawer' }));
  return within(screen.getByRole('dialog', { name: 'Cash drawer' }));
}

async function reopenPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer panel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  return openPanel();
}

describe('DrawerPanel', () => {
  it('hydrates, opens, adjusts, and closes the authenticated device drawer', async () => {
    const calls: { path: string; options?: TerminalRequestOptions }[] = [];
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      if (path.endsWith('/current')) return null as T;
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
    await within(dialog).findByText('No open drawer');

    fireEvent.change(within(dialog).getByLabelText('Opening float'), {
      target: { value: '100.00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open drawer' }));
    await within(dialog).findByText('drawer-1');

    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Movement', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'PAID_OUT' },
      }
    );
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

    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.map(({ path }) => path)).toEqual([
      '/api/restaurant/cash/drawer/current',
      '/api/restaurant/cash/drawer/open',
      '/api/restaurant/cash/drawer/movement',
      '/api/restaurant/cash/drawer/close',
    ]);
    expect(calls[2]?.options?.body).toEqual({
      drawerSessionId: 'drawer-1',
      kind: 'PAID_OUT',
      amount: '10.00',
      reason: 'Petty cash',
    });
    expect(calls[3]?.options?.body).toEqual({
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
      void options;
      if (path.endsWith('/current')) return null;
      return pendingOpen;
    });
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) =>
      (await requestMock(path, options)) as T;

    render(<DrawerPanel request={request} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cash drawer' }));
    const dialog = screen.getByRole('dialog', { name: 'Cash drawer' });
    await within(dialog).findByText('No open drawer');
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

  it('keeps loading and failed reads unknown and blocks writes until retry confirms empty', async () => {
    let rejectRead!: (reason: Error) => void;
    const { requestMock, request } = mockRequest();
    requestMock.mockReturnValueOnce(new Promise((_, reject) => (rejectRead = reject)));
    render(<DrawerPanel request={request} />);
    const panel = openPanel();

    expect(panel.getByText('Drawer state unknown')).toBeVisible();
    expect(panel.queryByText('No open drawer')).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
    expect(panel.queryByRole('button', { name: 'Record movement' })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Close drawer' })).not.toBeInTheDocument();
    fireEvent.submit(panel.getByLabelText('Opening float').closest('form')!);
    expect(requestMock).toHaveBeenCalledTimes(1);

    await act(async () => rejectRead(new Error('Network unavailable')));
    expect(panel.getByRole('alert')).toHaveTextContent('Could not verify drawer state.');
    expect(panel.queryByText('No open drawer')).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
    fireEvent.submit(panel.getByLabelText('Opening float').closest('form')!);
    expect(requestMock).toHaveBeenCalledTimes(1);

    let resolveRetry!: (value: null) => void;
    requestMock.mockReturnValueOnce(new Promise((resolve) => (resolveRetry = resolve)));
    fireEvent.click(panel.getByRole('button', { name: 'Retry drawer state' }));
    expect(panel.getByRole('status')).toHaveTextContent('Checking this register’s drawer.');
    expect(panel.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
    await act(async () => resolveRetry(null));

    expect(panel.getByText('No open drawer')).toBeVisible();
    expect(panel.getByRole('button', { name: 'Open drawer' })).toBeEnabled();
    expect(panel.queryByRole('alert')).not.toBeInTheDocument();
    expect(requestMock.mock.calls).toEqual([
      ['/api/restaurant/cash/drawer/current', undefined],
      ['/api/restaurant/cash/drawer/current', undefined],
    ]);
  });

  it('enables movement and close when retry recovers an open drawer', async () => {
    const { requestMock, request } = mockRequest();
    requestMock
      .mockRejectedValueOnce(new Error('Read timed out'))
      .mockResolvedValueOnce(activeDrawer);
    render(<DrawerPanel request={request} />);
    const panel = openPanel();
    fireEvent.click(await panel.findByRole('button', { name: 'Retry drawer state' }));

    expect(await panel.findByText('Active drawer')).toBeVisible();
    expect(panel.getByRole('button', { name: 'Record movement' })).toBeEnabled();
    expect(panel.getByRole('button', { name: 'Close drawer' })).toBeEnabled();
    expect(panel.queryByRole('button', { name: 'Open drawer' })).not.toBeInTheDocument();
    expect(panel.queryByText('Drawer state unknown')).not.toBeInTheDocument();
  });

  it('marks cached open state stale, blocks submissions and preserves drafts across failed refresh', async () => {
    const { requestMock, request } = mockRequest();
    requestMock
      .mockResolvedValueOnce(activeDrawer)
      .mockRejectedValueOnce(new Error('Read timed out'))
      .mockResolvedValueOnce(activeDrawer);
    render(<DrawerPanel request={request} />);
    let panel = openPanel();
    await panel.findByText('Active drawer');
    fireEvent.change(
      selectFieldControl(
        panel.getByLabelText('Movement', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'PAID_OUT' } }
    );
    fireEvent.change(panel.getByLabelText('Amount'), { target: { value: '10.50' } });
    fireEvent.change(panel.getByLabelText('Reason'), { target: { value: 'Petty cash' } });
    fireEvent.change(panel.getByLabelText('Counted cash'), { target: { value: '89.50' } });

    panel = await reopenPanel();
    await panel.findByRole('alert');
    expect(panel.getByText('Last known drawer')).toBeVisible();
    expect(panel.getByText(/Last known drawer details are stale/)).toBeVisible();
    expect(panel.queryByText('Active drawer')).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Record movement' })).toBeDisabled();
    expect(panel.getByRole('button', { name: 'Close drawer' })).toBeDisabled();
    expect(panel.queryByRole('button', { name: 'Open drawer' })).not.toBeInTheDocument();
    fireEvent.submit(panel.getByLabelText('Reason').closest('form')!);
    fireEvent.submit(panel.getByLabelText('Counted cash').closest('form')!);
    expect(requestMock).toHaveBeenCalledTimes(2);

    fireEvent.click(panel.getByRole('button', { name: 'Retry drawer state' }));
    await panel.findByText('Active drawer');
    expect(
      selectFieldControl(
        panel.getByLabelText('Movement', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('PAID_OUT');
    expect(panel.getByLabelText('Amount')).toHaveValue('10.50');
    expect(panel.getByLabelText('Reason')).toHaveValue('Petty cash');
    expect(panel.getByLabelText('Counted cash')).toHaveValue('89.50');
    expect(panel.getByRole('button', { name: 'Record movement' })).toBeEnabled();
    expect(panel.getByRole('button', { name: 'Close drawer' })).toBeEnabled();
    expect(panel.queryByText(/details are stale/)).not.toBeInTheDocument();
  });

  it.each([401, 403])(
    'distinguishes denied read access (%i) and supports authorized retry',
    async (status) => {
      const { requestMock, request } = mockRequest();
      requestMock
        .mockRejectedValueOnce(Object.assign(new Error('Access unavailable'), { status }))
        .mockResolvedValueOnce(null);
      render(<DrawerPanel request={request} />);
      const panel = openPanel();

      expect(await panel.findByRole('alert')).toHaveTextContent('Drawer access denied.');
      expect(panel.queryByText(/Could not verify drawer state/)).not.toBeInTheDocument();
      expect(panel.queryByText('No open drawer')).not.toBeInTheDocument();
      expect(panel.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
      fireEvent.submit(panel.getByLabelText('Opening float').closest('form')!);
      expect(requestMock).toHaveBeenCalledTimes(1);

      fireEvent.click(panel.getByRole('button', { name: 'Retry drawer state' }));
      await panel.findByText('No open drawer');
      expect(panel.getByRole('button', { name: 'Open drawer' })).toBeEnabled();
    }
  );

  it('preserves opening float through failed refresh and uncertain open retry with the same intent', async () => {
    const { requestMock, request } = mockRequest();
    requestMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Read timed out'))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Open response lost'))
      .mockResolvedValueOnce(activeDrawer);
    render(<DrawerPanel request={request} />);
    let panel = openPanel();
    await panel.findByText('No open drawer');
    fireEvent.change(panel.getByLabelText('Opening float'), { target: { value: '100.00' } });
    panel = await reopenPanel();
    await panel.findByRole('alert');
    expect(panel.getByLabelText('Opening float')).toHaveValue('100.00');
    expect(panel.getByLabelText('Opening float')).toBeDisabled();
    expect(panel.queryByText('No open drawer')).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'Retry drawer state' }));
    await panel.findByText('No open drawer');
    expect(panel.getByLabelText('Opening float')).toHaveValue('100.00');

    fireEvent.click(panel.getByRole('button', { name: 'Open drawer' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('Open response lost');
    expect(panel.getByLabelText('Opening float')).toHaveValue('100.00');
    expect(panel.queryByRole('button', { name: 'Retry drawer state' })).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'Open drawer' }));
    await panel.findByText('Active drawer');
    const expected = [
      '/api/restaurant/cash/drawer/open',
      {
        method: 'POST',
        body: { openingFloat: '100.00' },
        intent: 'drawer-open:{"openingFloat":"100.00"}',
      },
    ];
    expect(requestMock.mock.calls[3]).toEqual(expected);
    expect(requestMock.mock.calls[4]).toEqual(expected);
  });

  it('preserves movement and count on recoverable mutation failure and reuses exact request intents', async () => {
    const { requestMock, request } = mockRequest();
    requestMock
      .mockResolvedValueOnce(activeDrawer)
      .mockRejectedValueOnce(new Error('Movement response lost'))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Close response lost'))
      .mockResolvedValueOnce({
        drawerSessionId: 'drawer-1',
        expectedCash: '89.50',
        countedCash: '89.50',
        variance: '0.00',
        replayed: true,
      });
    render(<DrawerPanel request={request} />);
    const panel = openPanel();
    await panel.findByText('Active drawer');
    fireEvent.change(
      selectFieldControl(
        panel.getByLabelText('Movement', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'PAID_OUT' } }
    );
    fireEvent.change(panel.getByLabelText('Amount'), { target: { value: '10.50' } });
    fireEvent.change(panel.getByLabelText('Reason'), { target: { value: ' Petty cash ' } });
    fireEvent.change(panel.getByLabelText('Counted cash'), { target: { value: '89.50' } });
    fireEvent.click(panel.getByRole('button', { name: 'Record movement' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('Movement response lost');
    expect(
      selectFieldControl(
        panel.getByLabelText('Movement', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('PAID_OUT');
    expect(panel.getByLabelText('Amount')).toHaveValue('10.50');
    expect(panel.getByLabelText('Reason')).toHaveValue(' Petty cash ');
    expect(panel.getByLabelText('Counted cash')).toHaveValue('89.50');
    fireEvent.click(panel.getByRole('button', { name: 'Record movement' }));
    await panel.findByText('Cash movement recorded.');
    expect(panel.getByLabelText('Amount')).toHaveValue('');
    expect(panel.getByLabelText('Reason')).toHaveValue('');

    fireEvent.click(panel.getByRole('button', { name: 'Close drawer' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('Close response lost');
    expect(panel.getByLabelText('Counted cash')).toHaveValue('89.50');
    fireEvent.click(panel.getByRole('button', { name: 'Close drawer' }));
    await panel.findByText('Drawer closed.');

    const movementBody = {
      drawerSessionId: 'drawer-1',
      kind: 'PAID_OUT',
      amount: '10.50',
      reason: 'Petty cash',
    };
    const closeBody = { drawerSessionId: 'drawer-1', countedCash: '89.50' };
    expect(requestMock.mock.calls[1]).toEqual([
      '/api/restaurant/cash/drawer/movement',
      {
        method: 'POST',
        body: movementBody,
        intent: `drawer-movement:${JSON.stringify(movementBody)}`,
      },
    ]);
    expect(requestMock.mock.calls[2]).toEqual(requestMock.mock.calls[1]);
    expect(requestMock.mock.calls[3]).toEqual([
      '/api/restaurant/cash/drawer/close',
      { method: 'POST', body: closeBody, intent: `drawer-close:${JSON.stringify(closeBody)}` },
    ]);
    expect(requestMock.mock.calls[4]).toEqual(requestMock.mock.calls[3]);
    expect(requestMock).toHaveBeenCalledTimes(5);
  });

  it.each([null, activeDrawer])(
    'honors caller disablement inside an already open panel (%j)',
    async (current) => {
      const { requestMock, request } = mockRequest();
      requestMock.mockResolvedValueOnce(current);
      const { rerender } = render(<DrawerPanel request={request} />);
      const panel = openPanel();
      await panel.findByText(current ? 'Active drawer' : 'No open drawer');
      rerender(<DrawerPanel request={request} disabled />);

      const labels = current ? ['Reason', 'Counted cash'] : ['Opening float'];
      const actions = current ? ['Record movement', 'Close drawer'] : ['Open drawer'];
      for (const name of actions) expect(panel.getByRole('button', { name })).toBeDisabled();
      for (const label of labels) fireEvent.submit(panel.getByLabelText(label).closest('form')!);
      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(panel.getByRole('status')).toHaveTextContent('offline or busy');
      expect(panel.getByRole('button', { name: 'Close drawer panel' })).toBeEnabled();
    }
  );
});
