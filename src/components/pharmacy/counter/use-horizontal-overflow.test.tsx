import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHorizontalOverflow } from './use-horizontal-overflow';

function Strip() {
  const [ref, overflowing] = useHorizontalOverflow<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="strip" tabIndex={overflowing ? 0 : undefined}>
      <span>Bill open</span>
    </div>
  );
}

const sizes = { scrollWidth: 0, clientWidth: 0 };
let resized: (() => void) | null = null;

function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => sizes.scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => sizes.clientWidth);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resized = null;
});

describe('DEV-977 phase 3: a strip is a tab stop only while it scrolls', () => {
  it('is no tab stop while its content fits', () => {
    stubLayout();
    Object.assign(sizes, { scrollWidth: 600, clientWidth: 600 });
    render(<Strip />);
    expect(screen.getByTestId('strip')).not.toHaveAttribute('tabindex');
  });

  it('takes the focus once its content is wider than it, and gives it up when it fits again', () => {
    stubLayout();
    Object.assign(sizes, { scrollWidth: 900, clientWidth: 343 });
    render(<Strip />);
    expect(screen.getByTestId('strip')).toHaveAttribute('tabindex', '0');
    // The window widens: the strip now fits.
    Object.assign(sizes, { scrollWidth: 900, clientWidth: 1200 });
    act(() => resized?.());
    expect(screen.getByTestId('strip')).not.toHaveAttribute('tabindex');
    // It narrows again.
    Object.assign(sizes, { scrollWidth: 900, clientWidth: 700 });
    act(() => resized?.());
    expect(screen.getByTestId('strip')).toHaveAttribute('tabindex', '0');
  });

  it('ignores a sub-pixel difference', () => {
    stubLayout();
    Object.assign(sizes, { scrollWidth: 601, clientWidth: 600 });
    render(<Strip />);
    expect(screen.getByTestId('strip')).not.toHaveAttribute('tabindex');
  });
});
