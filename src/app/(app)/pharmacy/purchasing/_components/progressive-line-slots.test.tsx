import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProgressiveLineSlots } from './progressive-line-slots';

const lines = [0, 1, 2].map((line) => ({
  key: String(line),
  selector: (
    <label>
      Medicine {line + 1}
      <select defaultValue="">
        <option value="">Choose</option>
        <option value="medicine">Amoxicillin</option>
      </select>
    </label>
  ),
  fields: (
    <label>
      Packs {line + 1}
      <input />
    </label>
  ),
}));

describe('ProgressiveLineSlots', () => {
  it('starts with one picker and reveals its fields only after selection', () => {
    render(<ProgressiveLineSlots lines={lines} />);

    expect(screen.getByLabelText('Medicine 1')).toBeDefined();
    expect(screen.queryByLabelText('Medicine 2')).toBeNull();
    expect(screen.queryByLabelText('Packs 1')).toBeNull();

    fireEvent.change(screen.getByLabelText('Medicine 1'), { target: { value: 'medicine' } });
    expect(screen.getByLabelText('Packs 1')).toBeDefined();
  });

  it('adds one blank line at a time and removes the action at capacity', () => {
    render(<ProgressiveLineSlots lines={lines} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(screen.getByLabelText('Medicine 2')).toBeDefined();
    expect(screen.queryByLabelText('Medicine 3')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(screen.getByLabelText('Medicine 3')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
  });
});

it('preserves a cleared line draft but excludes its hidden fields from submission', () => {
  const { container } = render(
    <form>
      <ProgressiveLineSlots
        lines={lines.map((line, index) => ({
          ...line,
          fields: (
            <label>
              Packs {index + 1}
              <input name={`packs-${index}`} required />
            </label>
          ),
        }))}
      />
    </form>
  );
  const medicine = screen.getByLabelText('Medicine 1');
  fireEvent.change(medicine, { target: { value: 'medicine' } });
  fireEvent.change(screen.getByLabelText('Packs 1'), { target: { value: '12' } });
  fireEvent.change(medicine, { target: { value: '' } });
  const form = container.querySelector('form')!;
  expect(new FormData(form).has('packs-0')).toBe(false);
  expect(form.checkValidity()).toBe(true);
  fireEvent.change(medicine, { target: { value: 'medicine' } });
  expect(screen.getByLabelText('Packs 1')).toHaveValue('12');
  expect(new FormData(form).get('packs-0')).toBe('12');
});

it('focuses each added picker without submitting the surrounding form', () => {
  let submitted = false;
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted = true;
      }}
    >
      <ProgressiveLineSlots lines={lines} />
    </form>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
  expect(screen.getByLabelText('Medicine 2')).toHaveFocus();
  expect(submitted).toBe(false);
});

it('shows every initially populated line, including scanner capture fields', () => {
  render(
    <ProgressiveLineSlots
      lines={lines.map((line, index) => ({ ...line, initiallySelected: index === 2 }))}
    />
  );
  expect(screen.getByLabelText('Medicine 3')).toBeVisible();
  expect(screen.getByLabelText('Packs 3')).toBeVisible();
  expect(screen.queryByLabelText('Packs 1')).toBeNull();
});
