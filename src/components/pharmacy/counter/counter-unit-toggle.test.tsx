import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CounterUnitToggle } from './counter-unit-toggle';
import {
  previewSaleLine,
  saleUnitOptions,
  type PackLevelNode,
  type SaleUnitKind,
} from '@/lib/pharmacy/counter-pricing';

const PACK_LEVELS: PackLevelNode[] = [
  { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
  { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 },
  { id: 'unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
];

const OPTIONS = saleUnitOptions({
  packLevels: PACK_LEVELS,
  rootPackLevelId: 'box',
  unitsPerPack: 100,
});

function previewFor(kind: SaleUnitKind, quantity: number, availableUnits = 500) {
  return previewSaleLine({
    option: OPTIONS.find((option) => option.kind === kind)!,
    quantity,
    printedMrpMinor: 25_000,
    unitsPerPack: 100,
    availableUnits,
  });
}

function renderToggle(overrides: Partial<React.ComponentProps<typeof CounterUnitToggle>> = {}) {
  const props = {
    options: OPTIONS,
    onHandUnits: 500,
    selected: 'STRIP' as SaleUnitKind | null,
    quantity: '2',
    preview: previewFor('STRIP', 2),
    onSelect: vi.fn(),
    onQuantityChange: vi.fn(),
    ...overrides,
  };
  render(<CounterUnitToggle {...props} />);
  return props;
}

describe('CounterUnitToggle (POS-03)', () => {
  it('keys a standalone pack and its loose unit apart when they share a pack level', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const standalone = saleUnitOptions({
      packLevels: [{ id: 'flat', level: 'STRIP', parentPackLevelId: null, unitsPerParent: 10 }],
      rootPackLevelId: 'flat',
      unitsPerPack: 10,
    });
    const props = {
      onHandUnits: 500,
      selected: 'UNIT' as SaleUnitKind | null,
      quantity: '1',
      preview: null,
      onSelect: vi.fn(),
      onQuantityChange: vi.fn(),
    };
    const view = render(<CounterUnitToggle {...props} options={standalone} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    view.rerender(<CounterUnitToggle {...props} options={OPTIONS} />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it('renders one radio per sale unit the lot actually supports', () => {
    renderToggle();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Pack/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Strip/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Unit/ })).toBeTruthy();
  });

  it('marks only the selected unit as checked', () => {
    renderToggle({ selected: 'PACK' });
    expect(screen.getByRole('radio', { name: /Pack/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Strip/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('shows the canonical units each sale unit contains', () => {
    renderToggle();
    expect(screen.getByRole('radio', { name: /Pack/ }).textContent).toContain('100 units');
    expect(screen.getByRole('radio', { name: /Strip/ }).textContent).toContain('10 units');
    expect(screen.getByRole('radio', { name: /Unit/ }).textContent).toContain('1 units');
  });

  it('reports the selected unit on click', () => {
    const props = renderToggle();
    fireEvent.click(screen.getByRole('radio', { name: /Pack/ }));
    expect(props.onSelect).toHaveBeenCalledWith('PACK');
  });

  it('moves between units with the arrow keys and wraps at both ends', () => {
    const props = renderToggle({ selected: 'STRIP' });
    fireEvent.keyDown(screen.getByRole('radio', { name: /Strip/ }), { key: 'ArrowRight' });
    expect(props.onSelect).toHaveBeenLastCalledWith('UNIT');

    fireEvent.keyDown(screen.getByRole('radio', { name: /Pack/ }), { key: 'ArrowLeft' });
    expect(props.onSelect).toHaveBeenLastCalledWith('UNIT');

    fireEvent.keyDown(screen.getByRole('radio', { name: /Unit/ }), { key: 'ArrowRight' });
    expect(props.onSelect).toHaveBeenLastCalledWith('PACK');
  });

  it('keeps exactly one tab stop in the group', () => {
    renderToggle({ selected: 'STRIP' });
    const tabbable = screen
      .getAllByRole('radio')
      .filter((radio) => radio.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.textContent).toContain('Strip');
  });

  it('shows the keyboard chord beside each unit when one is supplied', () => {
    renderToggle({
      chordFor: (kind) => (kind === 'PACK' ? 'F3' : kind === 'STRIP' ? 'F4' : 'F5'),
    });
    expect(screen.getByRole('radio', { name: /Pack/ }).textContent).toContain('F3');
    expect(screen.getByRole('radio', { name: /Unit/ }).textContent).toContain('F5');
  });

  it('previews the exact quantity and price for the staged line', () => {
    renderToggle({ selected: 'STRIP', quantity: '3', preview: previewFor('STRIP', 3) });
    // 3 strips × 10 = 30 canonical units at 25.00 per strip = 75.00.
    expect(screen.getByText('30')).toBeTruthy();
    expect(screen.getByText('75.00')).toBeTruthy();
  });

  it('shows the pro-rata ceiling beside the derived unit price', () => {
    renderToggle({ selected: 'UNIT', quantity: '1', preview: previewFor('UNIT', 1) });
    const preview = previewFor('UNIT', 1);
    expect(preview.unitPriceMinor).toBeLessThanOrEqual(preview.proRataCeilingMinor);
    expect(screen.getByText('Pro-rata ceiling')).toBeTruthy();
  });

  it('reports a shortfall instead of quietly allowing an unfillable line', () => {
    renderToggle({ selected: 'PACK', quantity: '2', preview: previewFor('PACK', 2, 150) });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Short by 50 units');
    expect(alert.textContent).toContain('150 safe units');
    expect(screen.getByLabelText('Quantity').getAttribute('aria-invalid')).toBe('true');
  });

  it('confirms coverage when the branch can fill the line', () => {
    renderToggle({ selected: 'STRIP', quantity: '2', preview: previewFor('STRIP', 2, 500) });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Covered · 500 units on hand/)).toBeTruthy();
  });

  it('keeps the typed quantity text so the field can be cleared before replacement', () => {
    const props = renderToggle();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '' } });
    expect(props.onQuantityChange).toHaveBeenLastCalledWith('');

    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '0' } });
    expect(props.onQuantityChange).toHaveBeenLastCalledWith('0');

    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '7' } });
    expect(props.onQuantityChange).toHaveBeenLastCalledWith('7');
  });

  it('starts the stepper at one from an empty draft', () => {
    const props = renderToggle({ quantity: '', preview: null });
    expect(screen.getByLabelText('Quantity')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Decrease quantity' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(props.onQuantityChange).toHaveBeenCalledExactlyOnceWith('1');
  });

  it('steps a typed quantity numerically rather than appending to its text', () => {
    const props = renderToggle({ quantity: '8', preview: previewFor('STRIP', 8) });
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect(props.onQuantityChange).toHaveBeenLastCalledWith('9');
    fireEvent.click(screen.getByRole('button', { name: 'Decrease quantity' }));
    expect(props.onQuantityChange).toHaveBeenLastCalledWith('7');
  });

  it('provides 44px touch targets for every quantity stepper control', () => {
    renderToggle();
    expect(screen.getByRole('button', { name: 'Decrease quantity' })).toHaveClass('size-11');
    expect(screen.getByLabelText('Quantity')).toHaveClass('h-11');
    expect(screen.getByRole('button', { name: 'Increase quantity' })).toHaveClass('size-11');
  });

  it('disables every control when the counter is busy', () => {
    renderToggle({ disabled: true });
    for (const radio of screen.getAllByRole('radio')) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByLabelText('Quantity') as HTMLInputElement).disabled).toBe(true);
  });

  it('explains itself when the lot has no priceable sale unit', () => {
    renderToggle({ options: [], selected: null, preview: null });
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('No sale unit is available');
    expect(screen.getByRole('status')).toHaveTextContent('pack hierarchy does not match');
    expect(screen.getByRole('status')).not.toHaveTextContent('Out of stock');
  });

  it.each([false, true])('explains exhausted stock without a pack warning (inline: %s)', (inline) => {
    renderToggle({ options: [], onHandUnits: 0, selected: null, preview: null, inline });
    expect(screen.getByRole('status')).toHaveTextContent('Out of stock');
    expect(screen.getByRole('status')).toHaveTextContent('Capture as unfulfilled demand');
    expect(screen.getByRole('status')).not.toHaveTextContent('pack hierarchy');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
  });

  it('wraps the inline price preview instead of using fixed columns that overlap the Add button', () => {
    renderToggle({ inline: true });
    const preview = screen.getByText('Unit price').closest('dl')!;
    expect(preview.className).toContain('flex-wrap');
    expect(preview.className).toContain('min-w-0');
    expect(preview.className).not.toContain('grid-cols-3');
    expect(preview.parentElement!.className).toContain('flex-wrap');
  });
});
