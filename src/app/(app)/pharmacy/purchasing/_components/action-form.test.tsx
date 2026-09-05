import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
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
  it('navigates explicitly with success notice and selection intact', async () => {
    const destination =
      '/pharmacy/purchasing/orders?kind=success&outcome=committed&notice=Outcome&branch=b1&order=o1';
    const action = vi.fn().mockResolvedValue(destination);
    const { replace } = setup(action);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(replace).toHaveBeenCalledWith(`https://workspace.test${destination}`);
    expect(action.mock.calls[0][0].get('reference')).toBe('PO-1');
    expect(action.mock.calls[0][0].get('decision')).toBe('approve');
  });

  it('retains edited values and focuses the invalid field on server validation failure', async () => {
    const action = vi
      .fn()
      .mockResolvedValue(
        '/pharmacy/purchasing/orders?kind=error&outcome=rejected&notice=Reference+already+used&field=reference&order=o1'
      );
    const { replace } = setup(action);
    const input = screen.getByLabelText('Reference');
    fireEvent.change(input, { target: { value: 'EDITED-PO' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(input).toHaveValue('EDITED-PO');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Reference already used');
    expect(screen.getByRole('button')).not.toBeDisabled();
    fireEvent.change(input, { target: { value: 'CORRECTED-PO' } });
    action.mockResolvedValue('/pharmacy/purchasing/orders?kind=success&outcome=committed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(action).toHaveBeenCalledTimes(2);
    expect(action.mock.calls[1][0].get('reference')).toBe('CORRECTED-PO');
    expect(replace).toHaveBeenCalledOnce();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('focuses the error message when the server supplies no visible field', async () => {
    const { replace } = setup(
      vi
        .fn()
        .mockResolvedValue(
          '/pharmacy/purchasing/orders?kind=error&outcome=rejected&notice=Permission+denied'
        )
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('Permission denied');
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(['space-y-4', 'grid gap-4', 'flex flex-wrap gap-3'])(
    'keeps %s on a real parent of the original controls',
    (className) => {
      const { container } = render(
        <PurchasingActionForm action={vi.fn()} className={className}>
          <div>Fields</div>
          <button>Save</button>
        </PurchasingActionForm>
      );
      const fieldset = container.querySelector('fieldset')!;
      expect(fieldset).toHaveClass(className);
      expect(fieldset).not.toHaveClass('contents');
      expect([...fieldset.children].map((child) => child.tagName)).toEqual(['DIV', 'BUTTON']);
    }
  );

  it('renders disabled pre-hydration controls with no-JS and stalled-hydration guidance', () => {
    const html = renderToString(
      <PurchasingActionForm action={vi.fn()}>
        <input name="reference" />
        <button>Save</button>
      </PurchasingActionForm>
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    expect(container.querySelector('fieldset')).toHaveAttribute('disabled');
    expect(container.textContent).toContain('If controls stay disabled, reload this page.');
    expect(container.querySelector('noscript')?.textContent).toContain('Enable JavaScript');
  });

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
    await act(async () => resolve('/pharmacy/purchasing/orders?kind=success&outcome=committed'));
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

it.each([
  'kind=error',
  'kind=error&outcome=unknown',
  'kind=success',
  'kind=error&outcome=committed',
])('unclassified or contradictory outcome stays locked: %s', async (query) => {
  const action = vi.fn().mockResolvedValue(`/pharmacy/purchasing/orders?${query}`);
  const { form, replace } = setup(action);
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('check the record before retrying');
  expect(screen.getByRole('button')).toBeDisabled();
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
});
