import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CounterScanInput } from './counter-scan-input';
afterEach(() => vi.useRealTimers());
it('collects every digit locally and publishes ordinary typing only after 150ms', () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  render(
    <CounterScanInput aria-label="Scan" value="" resetVersion={0} onDebouncedChange={publish} />
  );
  const input = screen.getByLabelText('Scan');
  for (const value of ['8', '89', '896', '8964', '89640', '896400'])
    fireEvent.change(input, { target: { value } });
  expect(input).toHaveValue('896400');
  expect(publish).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(149));
  expect(publish).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(publish).toHaveBeenCalledExactlyOnceWith('896400');
});
it('keeps an uncommitted draft through parent echoes and honors explicit resets', () => {
  const publish = vi.fn();
  const view = render(
    <CounterScanInput aria-label="Scan" value="" resetVersion={0} onDebouncedChange={publish} />
  );
  fireEvent.change(screen.getByLabelText('Scan'), { target: { value: 'Panadol' } });
  view.rerender(
    <CounterScanInput aria-label="Scan" value="Pan" resetVersion={0} onDebouncedChange={publish} />
  );
  expect(screen.getByLabelText('Scan')).toHaveValue('Panadol');
  view.rerender(
    <CounterScanInput aria-label="Scan" value="" resetVersion={1} onDebouncedChange={publish} />
  );
  expect(screen.getByLabelText('Scan')).toHaveValue('');
});
it('cancels a pending search when Enter delivers the full barcode', () => {
  vi.useFakeTimers();
  const publish = vi.fn(),
    enter = vi.fn();
  render(
    <CounterScanInput
      aria-label="Scan"
      value=""
      resetVersion={0}
      onDebouncedChange={publish}
      onKeyDown={(event) => {
        if (event.key === 'Enter') enter(event.currentTarget.value);
      }}
    />
  );
  fireEvent.change(screen.getByLabelText('Scan'), { target: { value: '8964000111222' } });
  fireEvent.keyDown(screen.getByLabelText('Scan'), { key: 'Enter' });
  act(() => vi.advanceTimersByTime(150));
  expect(publish).not.toHaveBeenCalled();
  expect(enter).toHaveBeenCalledWith('8964000111222');
});
it('leaves GS1 acquisition to Enter and cancels queued typing on a branch reset', () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const view = render(
    <CounterScanInput aria-label="Scan" value="" resetVersion={0} onDebouncedChange={publish} />
  );
  fireEvent.change(screen.getByLabelText('Scan'), { target: { value: '(01)01234567890128' } });
  act(() => vi.advanceTimersByTime(500));
  expect(publish).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Scan'), { target: { value: 'Panadol' } });
  view.rerender(
    <CounterScanInput aria-label="Scan" value="" resetVersion={1} onDebouncedChange={publish} />
  );
  act(() => vi.advanceTimersByTime(150));
  expect(publish).not.toHaveBeenCalled();
});

it('uses the latest admission callback for an already queued draft', () => {
  vi.useFakeTimers();
  const oldScope = vi.fn(),
    currentScope = vi.fn();
  const view = render(
    <CounterScanInput aria-label="Scan" value="" resetVersion={0} onDebouncedChange={oldScope} />
  );
  fireEvent.change(screen.getByLabelText('Scan'), { target: { value: 'Panadol' } });
  view.rerender(
    <CounterScanInput
      aria-label="Scan"
      value=""
      resetVersion={0}
      onDebouncedChange={currentScope}
    />
  );
  act(() => vi.advanceTimersByTime(150));
  expect(oldScope).not.toHaveBeenCalled();
  expect(currentScope).toHaveBeenCalledWith('Panadol');
});
