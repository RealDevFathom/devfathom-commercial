import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScrollRail } from './scroll-rail';

const geometry = { scrollWidth: 0, clientWidth: 0 };

function rail() {
  return render(
    <ScrollRail label="purchasing tabs">
      <ul>
        <li>
          <a href="/a">Overview</a>
        </li>
        <li>
          <a href="/b" aria-current="page">
            Returns
          </a>
        </li>
      </ul>
    </ScrollRail>
  );
}

function viewport(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-slot="scroll-rail-viewport"]')!;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
    () => geometry.scrollWidth
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    () => geometry.clientWidth
  );
});

afterEach(() => vi.restoreAllMocks());

describe('ScrollRail', () => {
  it('shows no arrow when every item fits', () => {
    geometry.scrollWidth = 300;
    geometry.clientWidth = 300;
    rail();
    expect(screen.queryByRole('button', { name: /Scroll purchasing tabs/ })).toBeNull();
  });

  it('shows a forward arrow while items are hidden past the end', () => {
    geometry.scrollWidth = 700;
    geometry.clientWidth = 300;
    const { container } = rail();
    expect(screen.getByRole('button', { name: 'Scroll purchasing tabs forward' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Scroll purchasing tabs back' })).toBeNull();
    expect(container.querySelector('[data-slot="scroll-rail"]')).toHaveAttribute(
      'data-overflow-end',
      'true'
    );
    expect(viewport(container)).toHaveClass('overflow-x-auto');
  });

  it('shows the back arrow once scrolled and hides forward at the end', () => {
    geometry.scrollWidth = 700;
    geometry.clientWidth = 300;
    const { container } = rail();
    const element = viewport(container);
    element.scrollLeft = 400;
    fireEvent.scroll(element);
    expect(screen.getByRole('button', { name: 'Scroll purchasing tabs back' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Scroll purchasing tabs forward' })).toBeNull();
  });

  it('pages the row when an arrow is pressed', () => {
    geometry.scrollWidth = 700;
    geometry.clientWidth = 300;
    const scrollBy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
      configurable: true,
      value: scrollBy,
    });
    try {
      rail();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll purchasing tabs forward' }));
      expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }));
      expect(scrollBy.mock.calls[0]![0].left).toBeGreaterThan(0);
    } finally {
      delete (HTMLElement.prototype as { scrollBy?: unknown }).scrollBy;
    }
  });

  it('keeps every item a reachable link and the arrows out of the tab order', () => {
    geometry.scrollWidth = 700;
    geometry.clientWidth = 300;
    rail();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Scroll purchasing tabs forward' })).toHaveAttribute(
      'tabindex',
      '-1'
    );
  });
});
