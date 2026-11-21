import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef, useEffect, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SelectField } from './select-field';

function Options() {
  return (
    <>
      <option value="">Choose a tender</option>
      <option value="cash">Cash</option>
      <option value="card">Card</option>
    </>
  );
}

function bridge(trigger: HTMLElement): HTMLSelectElement {
  const control = document.getElementById(trigger.dataset.nativeControl!);
  expect(control).toBeInstanceOf(HTMLSelectElement);
  return control as HTMLSelectElement;
}

async function choose(trigger: HTMLElement, label: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const option = await screen.findByRole('option', { name: label });
  option.focus();
  fireEvent.keyDown(option, { key: 'Enter' });
  // A real browser synthesizes click for Enter; jsdom requires it explicitly.
  fireEvent.click(option, { detail: 0 });
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
}

describe('SelectField native form parity', () => {
  it('renders a usable native control before hydration', () => {
    const markup = renderToStaticMarkup(
      <label htmlFor="tender">
        Tender
        <SelectField id="tender" name="tender" defaultValue="cash" required>
          <Options />
        </SelectField>
      </label>
    );
    expect(markup).toContain('<select');
    expect(markup).toContain('id="tender"');
    expect(markup).toContain('name="tender"');
    expect(markup).toContain('required=""');
    expect(markup).not.toContain('aria-hidden="true"');
    expect(markup).not.toContain('class="sr-only"');
    expect(markup).toContain('value="cash" selected=""');
  });

  it('keeps explicit labels, descriptions, selected text and one focus target', () => {
    render(
      <>
        <label htmlFor="tender">Tender</label>
        <p id="tender-help">Choose how the customer pays.</p>
        <SelectField id="tender" name="tender" defaultValue="cash" aria-describedby="tender-help">
          <Options />
        </SelectField>
      </>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    expect(trigger).toHaveTextContent('Cash');
    expect(trigger).toHaveAccessibleDescription('Choose how the customer pays.');
    expect(trigger).toHaveClass('min-h-11', 'min-w-11');
    expect(bridge(trigger)).toHaveAttribute('aria-hidden', 'true');
    expect(bridge(trigger)).toHaveAttribute('tabindex', '-1');
    expect(bridge(trigger).labels?.[0].textContent).toBe('Tender');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('keeps a wrapping visible label associated with the shared trigger', () => {
    render(
      <label>
        Tender
        <SelectField defaultValue="cash">
          <Options />
        </SelectField>
      </label>
    );
    expect(screen.getByRole('combobox', { name: 'Tender' })).toHaveTextContent('Cash');
  });

  it('keeps both hidden controls small under auth and platform native field styles', () => {
    const { container } = render(
      <div className="studio-auth platform-workspace">
        <style>{`
          .studio-auth select, .studio-auth input {
            inline-size: 100%; min-block-size: 48px; padding-inline: 16px;
          }
          .platform-workspace select, .platform-workspace input { min-height: 44px; }
        `}</style>
        <SelectField aria-label="Tender" defaultValue="cash">
          <Options />
        </SelectField>
      </div>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    const controls = container.querySelectorAll<HTMLElement>(
      'select[aria-hidden], input[aria-hidden]'
    );
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      const computed = getComputedStyle(control);
      expect(computed.inlineSize).toBe('1px');
      expect(computed.blockSize).toBe('1px');
      expect(computed.minBlockSize).toBe('0px');
      expect(computed.minHeight).toBe('0px');
      expect(computed.paddingInline).toBe('0px');
    }
    expect(trigger).toHaveTextContent('Cash');
    expect(bridge(trigger)).toHaveValue('cash');
  });

  it('preserves controlled value and emits a real change event from the native form control', async () => {
    const changed = vi.fn();
    function Controlled() {
      const [value, setValue] = useState('cash');
      return (
        <form aria-label="Payment">
          <SelectField
            aria-label="Tender"
            name="tender"
            value={value}
            onChange={(event) => {
              changed(
                event.target instanceof HTMLSelectElement,
                event.currentTarget.name,
                event.currentTarget.form?.getAttribute('aria-label'),
                event.target.value
              );
              setValue(event.target.value);
            }}
          >
            <Options />
          </SelectField>
        </form>
      );
    }
    render(<Controlled />);
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    await choose(trigger, 'Card');
    expect(changed).toHaveBeenCalledExactlyOnceWith(true, 'tender', 'Payment', 'card');
    expect(trigger).toHaveTextContent('Card');
    expect(bridge(trigger)).toHaveValue('card');
    expect(new FormData(bridge(trigger).form!).getAll('tender')).toEqual(['card']);
  });

  it('does not change a controlled value when its owner does not accept the change', async () => {
    render(
      <SelectField aria-label="Tender" value="cash" onChange={() => {}}>
        <Options />
      </SelectField>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    await choose(trigger, 'Card');
    await waitFor(() => expect(trigger).toHaveTextContent('Cash'));
    expect(bridge(trigger)).toHaveValue('cash');
  });

  it('does not emit a change when the already selected option is chosen again', async () => {
    const changed = vi.fn();
    render(
      <SelectField aria-label="Tender" defaultValue="cash" onChange={changed}>
        <Options />
      </SelectField>
    );
    await choose(screen.getByRole('combobox', { name: 'Tender' }), 'Cash');
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps empty selection text and external form submission without duplicate fields', async () => {
    render(
      <>
        <form id="payment" aria-label="Payment" />
        <SelectField aria-label="Tender" form="payment" name="tender" defaultValue="">
          <Options />
        </SelectField>
      </>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    const form = screen.getByRole('form', { name: 'Payment' }) as HTMLFormElement;
    expect(trigger).toHaveTextContent('Choose a tender');
    expect(new FormData(form).getAll('tender')).toEqual(['']);
    await choose(trigger, 'Cash');
    expect(new FormData(form).getAll('tender')).toEqual(['cash']);
  });

  it('restores native default selection and displayed value after a form reset', async () => {
    render(
      <form aria-label="Payment">
        <SelectField aria-label="Tender" name="tender" defaultValue="cash">
          <Options />
        </SelectField>
      </form>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    await choose(trigger, 'Card');
    expect(bridge(trigger)).toHaveValue('card');
    await act(async () => bridge(trigger).form!.reset());
    await waitFor(() => expect(trigger).toHaveTextContent('Cash'));
    expect(new FormData(bridge(trigger).form!).get('tender')).toBe('cash');
  });

  it('matches a controlled native reset until the owner renders again', async () => {
    const { rerender } = render(
      <form>
        <SelectField aria-label="Shared" value="card" onChange={() => {}}>
          <Options />
        </SelectField>
        <select aria-label="Native" value="card" onChange={() => {}}>
          <Options />
        </select>
      </form>
    );
    const trigger = screen.getByRole('combobox', { name: 'Shared' });
    const native = screen.getByRole('combobox', { name: 'Native' });
    await act(async () => bridge(trigger).form!.reset());
    await waitFor(() => {
      expect(bridge(trigger).value).toBe((native as HTMLSelectElement).value);
      expect(trigger).toHaveTextContent('Choose a tender');
    });
    rerender(
      <form>
        <SelectField aria-label="Shared" value="card" onChange={() => {}}>
          <Options />
        </SelectField>
        <select aria-label="Native" value="card" onChange={() => {}}>
          <Options />
        </select>
      </form>
    );
    expect(trigger).toHaveTextContent('Card');
    expect(bridge(trigger).value).toBe((native as HTMLSelectElement).value);
  });

  it('preserves required validation and moves invalid native focus to the visible trigger', async () => {
    render(
      <form aria-label="Payment">
        <SelectField aria-label="Tender" name="tender" required defaultValue="">
          <Options />
        </SelectField>
      </form>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    expect(trigger).toHaveAttribute('aria-required', 'true');
    let valid = true;
    act(() => {
      valid = bridge(trigger).form!.checkValidity();
    });
    expect(valid).toBe(false);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAccessibleDescription(bridge(trigger).validationMessage);
    await choose(trigger, 'Card');
    expect(bridge(trigger).form!.checkValidity()).toBe(true);
    expect(trigger).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lets existing form validation handlers own their error message', () => {
    render(
      <form onInvalidCapture={(event) => event.preventDefault()}>
        <SelectField aria-label="Tender" required defaultValue="">
          <Options />
        </SelectField>
      </form>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    expect(bridge(trigger).checkValidity()).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('focuses the first invalid field when multiple selects are required', () => {
    render(
      <form>
        <SelectField aria-label="First" required defaultValue="">
          <Options />
        </SelectField>
        <SelectField aria-label="Second" required defaultValue="">
          <Options />
        </SelectField>
      </form>
    );
    const first = screen.getByRole('combobox', { name: 'First' });
    act(() => {
      bridge(first).form!.reportValidity();
    });
    expect(first).toHaveFocus();
  });

  it('clears its local validation notice on reset without removing the required constraint', async () => {
    render(
      <form>
        <SelectField aria-label="Tender" required defaultValue="">
          <Options />
        </SelectField>
      </form>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    act(() => {
      bridge(trigger).reportValidity();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await act(async () => bridge(trigger).form!.reset());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(bridge(trigger).validity.valueMissing).toBe(true);
    expect(trigger).toHaveAttribute('aria-required', 'true');
  });

  it('does not steal validation focus from an earlier invalid native input', () => {
    render(
      <form>
        <input aria-label="Reference" required />
        <SelectField aria-label="Tender" required defaultValue="">
          <Options />
        </SelectField>
      </form>
    );
    const input = screen.getByRole('textbox', { name: 'Reference' });
    input.focus();
    act(() => {
      bridge(screen.getByRole('combobox', { name: 'Tender' })).form!.reportValidity();
    });
    expect(input).toHaveFocus();
  });

  it.each(['prop', 'fieldset'])(
    'preserves %s disabling and excludes the field from submission',
    (kind) => {
      render(
        <form aria-label="Payment">
          <fieldset disabled={kind === 'fieldset'}>
            <SelectField
              aria-label="Tender"
              name="tender"
              defaultValue="cash"
              disabled={kind === 'prop'}
            >
              <Options />
            </SelectField>
          </fieldset>
        </form>
      );
      const trigger = screen.getByRole('combobox', { name: 'Tender' });
      expect(trigger).toBeDisabled();
      expect(new FormData(bridge(trigger).form!).has('tender')).toBe(false);
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    }
  );

  it('keeps disabled option groups and native first enabled fallback selection', async () => {
    render(
      <SelectField aria-label="Tender">
        <option value="offline" disabled>
          Offline
        </option>
        <option value="cash">Cash</option>
        <optgroup label="Unavailable" disabled>
          <option value="card">Card</option>
        </optgroup>
        <option value="bank">Bank</option>
      </SelectField>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    expect(trigger).toHaveTextContent('Cash');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const cash = await screen.findByRole('option', { name: 'Cash' });
    expect(screen.getByRole('option', { name: 'Card' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(cash, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bank' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps hidden selected labels but excludes hidden choices from keyboard navigation', async () => {
    render(
      <SelectField aria-label="Tender" defaultValue="">
        <option value="" hidden>
          Choose a tender
        </option>
        <option value="cash">Cash</option>
        <option value="card" hidden>
          Card
        </option>
        <option value="bank">Bank</option>
      </SelectField>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    expect(trigger).toHaveTextContent('Choose a tender');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const cash = await screen.findByRole('option', { name: 'Cash' });
    expect(screen.queryByRole('option', { name: 'Card' })).not.toBeInTheDocument();
    fireEvent.keyDown(cash, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bank' })).toHaveFocus());
  });

  it('reflects existing native helper value changes, focus calls and error attributes', async () => {
    render(
      <>
        <p id="error">Tender is required.</p>
        <SelectField aria-label="Tender" name="tender" defaultValue="cash">
          <Options />
        </SelectField>
      </>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    const native = bridge(trigger);
    fireEvent.change(native, { target: { value: 'card' } });
    expect(trigger).toHaveTextContent('Card');
    act(() => native.focus());
    expect(trigger).toHaveFocus();
    await act(async () => {
      native.setAttribute('aria-invalid', 'true');
      native.setAttribute('aria-describedby', 'error');
    });
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAccessibleDescription('Tender is required.');
    await act(async () => {
      native.removeAttribute('aria-invalid');
      native.removeAttribute('aria-describedby');
    });
    expect(trigger).not.toHaveAttribute('aria-invalid');
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('retains a native ref with options and forwards imperative focus to the shared trigger', () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <SelectField ref={ref} aria-label="Tender" defaultValue="cash">
        <Options />
      </SelectField>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    expect(ref.current).toBe(bridge(trigger));
    expect(ref.current?.options).toHaveLength(3);
    expect(ref.current?.value).toBe('cash');
    act(() => ref.current?.focus());
    expect(trigger).toHaveFocus();
  });

  it('hands initial parent opening focus to the trigger when enhancement mounts', () => {
    function Editor() {
      const selectRef = useRef<HTMLSelectElement>(null);
      useEffect(() => {
        selectRef.current?.focus();
      }, []);
      return (
        <SelectField ref={selectRef} aria-label="New status" defaultValue="cash">
          <Options />
        </SelectField>
      );
    }
    render(<Editor />);
    expect(screen.getByRole('combobox', { name: 'New status' })).toHaveFocus();
  });

  it('follows dynamic options when the native browser selection falls back', () => {
    const { rerender } = render(
      <SelectField aria-label="Tender" defaultValue="cash">
        <Options />
      </SelectField>
    );
    expect(screen.getByRole('combobox', { name: 'Tender' })).toHaveTextContent('Cash');
    rerender(
      <SelectField aria-label="Tender" defaultValue="cash">
        <option value="card">Card</option>
      </SelectField>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    expect(trigger).toHaveTextContent('Card');
    expect(bridge(trigger)).toHaveValue('card');
  });

  it('does not reread option metadata for value-only, parent or accessibility updates', async () => {
    function Medicines({ value, title }: { value: string; title: string }) {
      return (
        <SelectField aria-label="Medicine" value={value} title={title} onChange={() => {}}>
          {Array.from({ length: 128 }, (_, index) => (
            <option key={index} value={String(index)}>
              Medicine {index}
            </option>
          ))}
        </SelectField>
      );
    }
    const { rerender } = render(<Medicines value="0" title="Original" />);
    const trigger = screen.getByRole('combobox', { name: 'Medicine' });
    const native = bridge(trigger);
    // React itself reads option values when applying a controlled selection.
    // The label getter isolates the metadata traversal performed by SelectField.
    const readLabel = vi.spyOn(native.options[127], 'label', 'get');
    try {
      rerender(<Medicines value="127" title="Original" />);
      expect(trigger).toHaveTextContent('Medicine 127');
      expect(native).toHaveValue('127');
      rerender(<Medicines value="127" title="Updated parent" />);
      expect(trigger).toHaveAttribute('title', 'Updated parent');
      await act(async () => native.setAttribute('aria-invalid', 'true'));
      expect(trigger).toHaveAttribute('aria-invalid', 'true');
      expect(readLabel).not.toHaveBeenCalled();
    } finally {
      readLabel.mockRestore();
    }
  });

  it('refreshes cached option text, values and group state after native option mutations', async () => {
    render(
      <form aria-label="Payment">
        <SelectField aria-label="Tender" name="tender" defaultValue="cash">
          <optgroup label="Methods">
            <option value="cash">Cash</option>
            <option value="card">Card</option>
          </optgroup>
          <option value="bank">Bank</option>
        </SelectField>
      </form>
    );
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    const native = bridge(trigger);
    const cash = native.options[0];
    const card = native.options[1];
    const group = cash.parentElement as HTMLOptGroupElement;
    await act(async () => {
      cash.firstChild!.textContent = 'Counter cash';
      cash.value = 'notes';
      card.label = 'Credit card';
      group.label = 'At the counter';
      group.disabled = true;
    });
    expect(trigger).toHaveTextContent('Counter cash');
    expect(native).toHaveValue('notes');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(await screen.findByRole('group', { name: 'At the counter' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Counter cash' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('option', { name: 'Credit card' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await act(async () => {
      group.disabled = false;
      cash.hidden = true;
      card.disabled = true;
    });
    expect(screen.queryByRole('option', { name: 'Counter cash' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Credit card' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await act(async () => {
      group.hidden = true;
    });
    expect(screen.queryByRole('option', { name: 'Credit card' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bank' })).toBeInTheDocument();
  });
});
