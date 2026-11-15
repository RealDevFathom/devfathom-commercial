import { act, fireEvent, render, screen } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCAN_SEARCH_DEBOUNCE_MS, ScanSearch } from './scan-search';

/**
 * DEV-734 — "Scan or search" on goods in only searched on Enter, so typing
 * "pan" showed nothing. Typing now lists matching products once it pauses,
 * while a scan (code then Enter) still submits the form as typed.
 */
const MEDICINES = [
  { id: 'med-amox', productName: 'Amoxil 500', brandName: null },
  { id: 'med-pan', productName: 'Panadol 500mg', brandName: 'Panadol' },
  { id: 'med-panex', productName: 'Panadol Extra', brandName: null },
  { id: 'med-brufen', productName: 'Ibuprofen 400', brandName: 'Brufen' },
];

function harness(defaultValue = '') {
  const submitted: string[] = [];
  const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitted.push(String(new FormData(event.currentTarget).get('scan')));
  });
  render(
    <form onSubmit={onSubmit}>
      <ScanSearch defaultValue={defaultValue} medicines={MEDICINES} />
      <button type="submit">Find line</button>
    </form>
  );
  const input = screen.getByRole('combobox', { name: /Scan or search/ });
  return { input, onSubmit, submitted };
}

/** The polite live region the box is described by. */
function announcement(input: HTMLElement) {
  const region = document.getElementById(input.getAttribute('aria-describedby') ?? '');
  expect(region).toHaveAttribute('aria-live', 'polite');
  return region;
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;

describe('ScanSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no requestSubmit; route it through a real submit event.
    HTMLFormElement.prototype.requestSubmit = function requestSubmit(this: HTMLFormElement) {
      this.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    HTMLFormElement.prototype.requestSubmit = nativeRequestSubmit;
  });

  it('lists matching products after typing pauses, without pressing Enter', () => {
    const { input, onSubmit } = harness();
    expect(input).toHaveFocus();
    type(input, 'pan');
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS - 1));
    expect(screen.queryByRole('listbox')).toBeNull();
    act(() => vi.advanceTimersByTime(1));

    const list = screen.getByRole('listbox', { name: 'Matching products' });
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Panadol 500mgPanadol',
      'Panadol Extra',
    ]);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(announcement(input)).toHaveTextContent('2 matching products');
  });

  it('matches a brand name and debounces a burst of keystrokes into one search', () => {
    const { input } = harness();
    type(input, 'b');
    act(() => vi.advanceTimersByTime(100));
    type(input, 'br');
    act(() => vi.advanceTimersByTime(100));
    type(input, 'bru');
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole('listbox')).toBeNull();
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Ibuprofen 400Brufen',
    ]);
  });

  it('chooses a product with the arrow keys and Enter, submitting its full name', () => {
    const { input, submitted } = harness();
    type(input, 'panadol');
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submitted).toEqual(['Panadol 500mg']);
    expect(input).toHaveValue('Panadol 500mg');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('chooses a product by click', () => {
    const { input, submitted } = harness();
    type(input, 'extra');
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS));
    fireEvent.click(screen.getByRole('option', { name: 'Panadol Extra' }));
    expect(submitted).toEqual(['Panadol Extra']);
  });

  it('closes the list on Escape without submitting', () => {
    const { input, onSubmit } = harness();
    type(input, 'pan');
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS));
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('leaves a barcode scan (code then Enter) to submit exactly what was typed', () => {
    const { input } = harness();
    const payload = ']d201089612345678941727123110ABCD1234';
    type(input, payload);
    // The scanner's Enter arrives before typing pauses; no suggestion is picked.
    const enter = fireEvent.keyDown(input, { key: 'Enter' });
    expect(enter).toBe(true);
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue(payload);
  });

  it('does not pick a suggestion on Enter unless the operator moved onto one', () => {
    const { input } = harness();
    type(input, 'pan');
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS));
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    expect(input).toHaveValue('pan');
  });

  it('says so when no product name matches', () => {
    const { input } = harness();
    type(input, 'zzz');
    act(() => vi.advanceTimersByTime(SCAN_SEARCH_DEBOUNCE_MS));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(announcement(input)).toHaveTextContent(
      'No product name matches “zzz”. Press Enter to look it up as a code.'
    );
  });

  it('keeps the last scanned term in the box', () => {
    const { input } = harness('Amoxil 500');
    expect(input).toHaveValue('Amoxil 500');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
