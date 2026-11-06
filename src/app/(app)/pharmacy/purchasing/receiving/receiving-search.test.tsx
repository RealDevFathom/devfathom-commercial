import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReceivingSearch } from './receiving-search';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  return render(
    <ReceivingSearch
      branchId="b1"
      orderId="o1"
      receiptId="r1"
      initialTerm=""
      medicines={[
        { id: '1', productName: 'Panadol' },
        { id: '2', productName: 'Pantoprazole' },
        { id: '3', productName: 'Aspirin' },
      ]}
    />
  );
}

it('debounces name results and replaces them when typing continues or is cleared', () => {
  setup();
  const input = screen.getByLabelText('Scan or search');
  fireEvent.change(input, { target: { value: 'pan' } });
  act(() => vi.advanceTimersByTime(249));
  expect(screen.queryByRole('button', { name: 'Panadol' })).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('button', { name: 'Panadol' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pantoprazole' })).toBeInTheDocument();
  fireEvent.change(input, { target: { value: 'asp' } });
  expect(screen.queryByRole('button', { name: 'Panadol' })).toBeNull();
  act(() => vi.advanceTimersByTime(250));
  expect(screen.getByRole('button', { name: 'Aspirin' })).toBeInTheDocument();
  fireEvent.change(input, { target: { value: '' } });
  act(() => vi.advanceTimersByTime(250));
  expect(screen.queryByRole('list', { name: 'Matching products' })).toBeNull();
});

it('keeps the GET form for Enter and scanner payloads, and submits a keyboard-accessible result', () => {
  const { container } = setup();
  const form = container.querySelector('form')!;
  const input = screen.getByLabelText('Scan or search');
  expect(form).toHaveAttribute('method', 'get');
  fireEvent.change(input, { target: { value: '01012345678901281727010010LOT' } });
  expect(new FormData(form).get('scan')).toBe('01012345678901281727010010LOT');
  expect(new FormData(form).get('branch')).toBe('b1');
  expect(new FormData(form).get('order')).toBe('o1');
  expect(new FormData(form).get('receipt')).toBe('r1');
  fireEvent.change(input, { target: { value: 'pan' } });
  act(() => vi.advanceTimersByTime(250));
  const submit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => {});
  const result = screen.getByRole('button', { name: 'Pantoprazole' });
  result.focus();
  expect(result).toHaveFocus();
  fireEvent.click(result);
  expect(submit).toHaveBeenCalledOnce();
  expect(new FormData(form).get('scan')).toBe('Pantoprazole');
  expect(new FormData(form).get('scanMedicine')).toBe('2');
});

it('does not search intermediate IME composition or update after unmount', () => {
  const { unmount } = setup();
  const input = screen.getByLabelText('Scan or search');
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: 'pan' } });
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole('button', { name: 'Panadol' })).toBeNull();
  fireEvent.compositionEnd(input);
  act(() => vi.advanceTimersByTime(250));
  expect(screen.getByRole('button', { name: 'Panadol' })).toBeInTheDocument();
  unmount();
});
