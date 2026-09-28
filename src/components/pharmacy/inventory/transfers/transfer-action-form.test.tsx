import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TransferActionForm } from './transfer-action-form';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('./transfer-navigation', () => ({ loadTransfersPage: mocks.load }));

function renderForm(action: (data: FormData) => Promise<string>) {
  render(
    <TransferActionForm action={action} label="Approve">
      <input name="transferId" type="hidden" value="transfer_1" />
      <button type="submit">Approve TR-1</button>
    </TransferActionForm>
  );
  return screen.getByRole('form', { name: 'Approve' });
}

describe('TransferActionForm', () => {
  beforeEach(() => {
    mocks.load.mockReset();
  });

  it('submits once, then loads the returned destination with controls locked', async () => {
    const action = vi.fn<(data: FormData) => Promise<string>>(
      async () => '/pharmacy/inventory/transfers?branch=b1&notice=Approved&kind=success'
    );
    const form = renderForm(action);
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith(
        '/pharmacy/inventory/transfers?branch=b1&notice=Approved&kind=success'
      )
    );
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![0].get('transferId')).toBe('transfer_1');
    // The step committed; nothing may be re-sent while the next page loads.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve TR-1' }).matches(':disabled')).toBe(true)
    );
    fireEvent.submit(form);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('refuses a destination outside the transfers console', async () => {
    const form = renderForm(async () => 'https://attacker.example/pharmacy/inventory/transfers');
    fireEvent.submit(form);

    expect(await screen.findByRole('alert')).toHaveTextContent('did not confirm this step');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('never retries a step whose response was lost', async () => {
    const action = vi.fn(async () => {
      throw new Error('network');
    });
    const form = renderForm(action);
    fireEvent.submit(form);

    expect(await screen.findByRole('alert')).toHaveTextContent('Reload the page');
    expect(action).toHaveBeenCalledTimes(1);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
