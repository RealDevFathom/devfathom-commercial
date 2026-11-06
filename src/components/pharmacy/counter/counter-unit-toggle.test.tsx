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
  it('renders one radio per sale unit the lot actually supports', () => {
    renderToggle();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Pack/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Strip/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Unit/ })).toBeTruthy();
  });

  it('shows a single selected sale unit as a label while retaining quantity entry', () => {
    renderToggle({ options: [OPTIONS[2]!], selected: 'UNIT', preview: previewFor('UNIT', 2) });
    expect(screen.getByText('Sale unit')).toBeVisible();
    expect(screen.getByText('Unit')).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toBeEnabled();
  });

  it('allows the only option to be selected if no unit has been selected yet', () => {
    const props = renderToggle({ options: [OPTIONS[2]!], selected: null, preview: null });
    fireEvent.click(screen.getByRole('radio', { name: /Unit/ }));
    expect(props.onSelect).toHaveBeenCalledWith('UNIT');
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
    expect(screen.getByRole('radio', { name: /Unit/ })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('radio', { name: /Pack/ }), { key: 'ArrowLeft' });
    expect(props.onSelect).toHaveBeenLastCalledWith('UNIT');

    fireEvent.keyDown(screen.getByRole('radio', { name: /Unit/ }), { key: 'ArrowRight' });
    expect(props.onSelect).toHaveBeenLastCalledWith('PACK');
    expect(screen.getByRole('radio', { name: /Pack/ })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('radio', { name: /Pack/ }), { key: 'ArrowUp' });
    expect(props.onSelect).toHaveBeenLastCalledWith('UNIT');
    expect(screen.getByRole('radio', { name: /Unit/ })).toHaveFocus();
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
  });
});
