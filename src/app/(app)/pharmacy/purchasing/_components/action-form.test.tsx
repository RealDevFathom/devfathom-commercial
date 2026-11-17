import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PurchasingActionForm } from './action-form';
import { TextField } from './form-controls';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
beforeEach(() => {
  router.refresh.mockReset();
});
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
  it('shows success and refreshes the current selection without document navigation', async () => {
    const destination =
      '/pharmacy/purchasing/orders?kind=success&outcome=committed&notice=Outcome&branch=b1&order=o1';
    const action = vi.fn().mockResolvedValue(destination);
    const { replace } = setup(action);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Outcome');
    expect(action.mock.calls[0][0].get('reference')).toBe('PO-1');
    expect(action.mock.calls[0][0].get('decision')).toBe('approve');
  });

  it('accepts a rejected reorder outcome and unlocks the form for correction (DEV-678)', async () => {
    const action = vi
      .fn()
      .mockResolvedValue(
        '/pharmacy/purchasing/reorder?kind=error&outcome=rejected&notice=Keep+at+least+one+line&field=reference&branch=b1'
      );
    setup(action);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByLabelText('Reference')).toHaveAccessibleDescription(
      'Keep at least one line'
    );
    expect(screen.getByRole('button')).not.toBeDisabled();
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
    expect(replace).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalledOnce();
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
    expect(replace).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalledTimes(1);
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

it('preserves sibling drafts, selection and focus while refreshing committed data', async () => {
  let complete!: (value: string) => void;
  const action = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      })
  );
  function Workspace({ count }: { count: number }) {
    return (
      <>
        <p>Records: {count}</p>
        <PurchasingActionForm action={action}>
          <button>Save record</button>
        </PurchasingActionForm>
        <PurchasingActionForm action={vi.fn()}>
          <input aria-label="Sibling draft" name="draft" defaultValue="Original" />
          <select aria-label="Sibling supplier" name="supplier" defaultValue="a">
            <option value="a">A</option>
            <option value="b">B</option>
          </select>
        </PurchasingActionForm>
      </>
    );
  }
  const view = render(<Workspace count={0} />);
  // Model the boundary that destroys browser drafts: a new document remounts defaults.
  const replace = vi.fn(() => view.rerender(<Workspace key="new-document" count={1} />));
  const location = {
    origin: 'https://workspace.test',
    href: 'https://workspace.test/pharmacy/purchasing/orders?branch=b1&po=existing',
    replace,
  };
  vi.stubGlobal('window', { document, location });
  router.refresh.mockImplementation(() => view.rerender(<Workspace count={1} />));
  fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
  fireEvent.change(screen.getByLabelText('Sibling supplier'), { target: { value: 'b' } });
  const draft = screen.getByLabelText('Sibling draft') as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unsaved sibling text' } });
  draft.focus();
  draft.setSelectionRange(2, 7);
  await act(async () => {
    complete(
      '/pharmacy/purchasing/orders?kind=success&outcome=committed&notice=Order+saved&po=new'
    );
  });
  expect(screen.getByLabelText('Sibling draft')).toHaveValue('Unsaved sibling text');
  expect(screen.getByLabelText('Sibling supplier')).toHaveValue('b');
  expect(draft).toHaveFocus();
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 7]);
  expect(location.href).toContain('po=existing');
  expect(replace).not.toHaveBeenCalled();
  expect(router.refresh).toHaveBeenCalledOnce();
  expect(screen.getByText('Records: 1')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Order saved');
  expect(screen.getByRole('button')).toBeDisabled();
});

it('keeps confirmed writes locked when requesting the refresh throws', async () => {
  const action = vi
    .fn()
    .mockResolvedValue(
      '/pharmacy/purchasing/orders?kind=success&outcome=committed&notice=Order+saved'
    );
  const { form, replace } = setup(action);
  router.refresh.mockImplementation(() => {
    throw new Error('refresh unavailable');
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
  expect(screen.getByRole('status')).toHaveTextContent('Order saved');
  expect(screen.getByRole('alert')).toHaveTextContent('records could not be refreshed');
  expect(screen.getByRole('button')).toBeDisabled();
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(action).toHaveBeenCalledOnce();
  expect(router.refresh).toHaveBeenCalledOnce();
  expect(replace).not.toHaveBeenCalled();
});

describe('required-field validation (DEV-520)', () => {
  it('explains an empty required field inline, blocks the write and clears on correction', async () => {
    const action = vi
      .fn()
      .mockResolvedValue('/pharmacy/purchasing/suppliers?kind=success&outcome=committed');
    vi.stubGlobal('window', {
      document,
      location: { origin: 'https://workspace.test', replace: vi.fn() },
    });
    render(
      <PurchasingActionForm action={action}>
        <TextField label="Trading name" name="name" notice={null} required hint="Team name." />
        <button type="submit">Add supplier</button>
      </PurchasingActionForm>
    );
    const field = screen.getByLabelText('Trading name');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    });
    expect(action).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/Trading name is required\./);
    expect(screen.getByRole('alert')).toHaveTextContent('Trading name is required.');
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'Acme Distributors' } });
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    });
    expect(action).toHaveBeenCalledOnce();
    expect(action.mock.calls[0][0].get('name')).toBe('Acme Distributors');
  });

  it('shows a new required-field error ahead of a retained server rejection', async () => {
    const action = vi
      .fn()
      .mockResolvedValue(
        '/pharmacy/purchasing/orders?kind=error&outcome=rejected&notice=Duplicate+reference&field=other'
      );
    vi.stubGlobal('window', {
      document,
      location: { origin: 'https://workspace.test', replace: vi.fn() },
    });
    render(
      <PurchasingActionForm action={action}>
        <TextField label="Reference" name="reference" notice={null} required />
        <TextField label="Other" name="other" notice={null} />
        <button type="submit">Save</button>
      </PurchasingActionForm>
    );
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: 'PO-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Duplicate reference');
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Reference is required.');
    expect(screen.getByLabelText('Reference')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the required-field error while an unrelated field is edited', async () => {
    const action = vi.fn();
    vi.stubGlobal('window', {
      document,
      location: { origin: 'https://workspace.test', replace: vi.fn() },
    });
    render(
      <PurchasingActionForm action={action}>
        <TextField label="Trading name" name="name" notice={null} required />
        <TextField label="Contact name" name="contactName" notice={null} />
        <button type="submit">Add supplier</button>
      </PurchasingActionForm>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    });
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Ali' } });
    expect(screen.getByLabelText('Trading name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Trading name is required.');
  });
});
