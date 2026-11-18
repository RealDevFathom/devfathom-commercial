import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TabRail } from './tab-rail';

function rect(left: number, width: number) {
  return { left, right: left + width, width, top: 0, bottom: 40, height: 40, x: left, y: 0 };
}

function layOut(boxes: Record<string, ReturnType<typeof rect>>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const key = this.getAttribute('aria-label') ?? this.textContent ?? '';
    return (boxes[key] ?? rect(0, 0)) as DOMRect;
  });
}

function tabs(current: string) {
  return (
    <TabRail label="Purchasing surfaces">
      <ul>
        {['Overview', 'Suppliers', 'Returns & claims', 'Price lists'].map((label) => (
          <li key={label}>
            <a href={`#${label}`} aria-current={label === current ? 'page' : undefined}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </TabRail>
  );
}

describe('TabRail (DEV-44)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens with a tab past the rail edge scrolled into view, not reset to the start', () => {
    layOut({ 'Purchasing surfaces': rect(0, 320), 'Price lists': rect(400, 120) });
    render(tabs('Price lists'));
    expect(screen.getByRole('navigation', { name: 'Purchasing surfaces' }).scrollLeft).toBe(200);
  });

  it('leaves the rail where it is when the current tab is already visible', () => {
    layOut({ 'Purchasing surfaces': rect(0, 320), Overview: rect(0, 100) });
    render(tabs('Overview'));
    expect(screen.getByRole('navigation', { name: 'Purchasing surfaces' }).scrollLeft).toBe(0);
  });
});
