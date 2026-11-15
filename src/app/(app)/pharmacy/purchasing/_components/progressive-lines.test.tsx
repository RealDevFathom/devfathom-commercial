import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REVEAL_LINES_EVENT, ProgressiveLines } from './progressive-lines';

const lines = [0, 1].map((index) => ({
  selector: (
    <label>
      Medicine {index + 1}
      <select name={`medicine-${index}`} defaultValue="">
        <option value="">Choose</option>
        <option value="pack">Pack</option>
      </select>
    </label>
  ),
  fields: (
    <label>
      Quantity {index + 1}
      <input name={`quantity-${index}`} />
    </label>
  ),
}));

describe('progressive purchasing lines', () => {
  it('reveals capture fields on selection and adds one line at a time', () => {
    render(
      <form aria-label="Purchase">
        <ProgressiveLines lines={lines} />
      </form>
    );
    expect(screen.getByLabelText('Medicine 1')).toBeVisible();
    expect(screen.queryByLabelText('Medicine 2')).toBeNull();
    expect(screen.getByLabelText('Quantity 1')).not.toBeVisible();
    fireEvent.change(screen.getByLabelText('Medicine 1'), { target: { value: 'pack' } });
    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(screen.getByLabelText('Medicine 2')).toBeVisible();
    expect(screen.getByLabelText('Quantity 2')).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
    expect(
      new FormData(screen.getByRole('form', { name: 'Purchase' }) as HTMLFormElement).get(
        'quantity-0'
      )
    ).toBe('4');
  });

  it('shows fields for a preselected scanned pack', () => {
    render(<ProgressiveLines lines={[{ ...lines[0], selected: true }]} />);
    expect(screen.getByLabelText('Quantity 1')).toBeVisible();
  });

  it('mounts the lines a reader asks for before the reveal returns (DEV-679)', () => {
    const { container } = render(
      <form aria-label="Purchase">
        <ProgressiveLines lines={lines} />
      </form>
    );
    expect(screen.queryByLabelText('Medicine 2')).toBeNull();
    container
      .querySelector('[data-progressive-lines]')!
      .dispatchEvent(new CustomEvent(REVEAL_LINES_EVENT, { detail: { count: 5 } }));
    // Synchronously mounted, and never more lines than exist.
    expect(screen.getByLabelText('Medicine 2')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
  });
});
