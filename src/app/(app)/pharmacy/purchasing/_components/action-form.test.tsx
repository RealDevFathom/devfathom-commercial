import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PurchasingActionForm } from './action-form';

afterEach(() => vi.unstubAllGlobals());

function setup(action: (form: FormData) => Promise<string>) {
  const replace = vi.fn();
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test', replace } });
  const view = render(
    <PurchasingActionForm action={action}>
      <input name="reference" defaultValue="PO-1" aria-label="Reference" />
      <button name="decision" value="approve" type="submit">
        Approve
      </button>
    </PurchasingActionForm>
  );
  return { ...view, replace, form: view.container.querySelector('form')! };
}

describe('purchasing outcome delivery', () => {
  it.each(['success', 'error'])(
    'navigates explicitly with %s notice and selection intact',
    async (kind) => {
      const destination = `/pharmacy/purchasing/orders?kind=${kind}&notice=Outcome&branch=b1&order=o1&field=reference`;
      const action = vi.fn().mockResolvedValue(destination);
      const { replace } = setup(action);
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(replace).toHaveBeenCalledWith(`https://workspace.test${destination}`);
      expect(action.mock.calls[0][0].get('reference')).toBe('PO-1');
      expect(action.mock.calls[0][0].get('decision')).toBe('approve');
    }
  );

  it('blocks duplicate submissions while awaiting the outcome and navigation', async () => {
    let resolve!: (value: string) => void;
    const action = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        })
    );
    const { form, replace } = setup(action);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving');
    await act(async () => resolve('/pharmacy/purchasing/orders?kind=success'));
    expect(replace).toHaveBeenCalledTimes(1);
    fireEvent.submit(form);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('keeps entered values and reports an uncertain outcome without retrying', async () => {
    const action = vi.fn().mockRejectedValue(new Error('lost response'));
    const { form, replace } = setup(action);
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent('check the record before retrying');
    expect(screen.getByLabelText('Reference')).toHaveValue('PO-1');
    expect(replace).not.toHaveBeenCalled();
    fireEvent.submit(form);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(['https://outside.test/pharmacy/purchasing/orders', '/admin', 'javascript:alert(1)'])(
    'rejects an invalid outcome destination: %s',
    async (destination) => {
      const { form, replace } = setup(vi.fn().mockResolvedValue(destination));
      fireEvent.submit(form);
      expect(await screen.findByRole('alert')).toBeVisible();
      expect(replace).not.toHaveBeenCalled();
    }
  );
});
