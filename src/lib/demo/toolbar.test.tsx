// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoToolbar } from './toolbar';
import { DEMO_TOUR_STORAGE_KEY } from './tour';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: mocks.push }),
}));

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('DemoToolbar', () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.reload.mockReset();
    vi.stubGlobal('location', { reload: mocks.reload });
    sessionStorage.clear();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resets only the current seat and fully reloads the page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ resetAt: '2026-09-04T10:00:00.000Z', summary: { orders: 8 } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<DemoToolbar seatName="Sales seat one" />);

    const resetTrigger = screen.getByRole('button', { name: 'Reset my seat' });
    fireEvent.click(resetTrigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset seat' }));

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/demo/restaurants/reset',
      expect.objectContaining({ method: 'POST' })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sales seat one reset. Seeded operations are ready.'
    );
    await waitFor(() => expect(resetTrigger).toHaveFocus());
  });

  it('keeps reset disabled for the server-authoritative cooldown', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ error: 'Seat was reset recently.', retryAfter: 600 }, 429));
    vi.stubGlobal('fetch', fetchMock);
    render(<DemoToolbar seatName="Sales seat one" />);

    fireEvent.click(screen.getByRole('button', { name: 'Reset my seat' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset seat' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Seat was reset recently.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(await screen.findByRole('button', { name: 'Reset in 600s' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('ends the active tour on Escape, clears storage, and restores focus', async () => {
    const target = document.createElement('section');
    target.dataset.tour = 'dashboard-overview';
    target.textContent = 'Seeded restaurant dashboard';
    document.body.append(target);
    render(<DemoToolbar seatName="Sales seat one" />);

    const start = screen.getByRole('button', { name: 'Start tour' });
    fireEvent.click(start);
    expect(await screen.findByRole('dialog', { name: 'Chain overview' })).toBeInTheDocument();
    expect(sessionStorage.getItem(DEMO_TOUR_STORAGE_KEY)).not.toBeNull();

    const collapse = screen.getByRole('button', { name: 'Collapse guide' });
    fireEvent.click(collapse);
    const show = screen.getByRole('button', { name: 'Show guide' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(show).toHaveFocus());
    expect(screen.getByRole('button', { name: 'End tour' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next' })).toBeVisible();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Chain overview' })).not.toBeInTheDocument()
    );
    expect(sessionStorage.getItem(DEMO_TOUR_STORAGE_KEY)).toBeNull();
    await waitFor(() => expect(start).toHaveFocus());
    target.remove();
  });

  it('keeps the tour usable when the sessionStorage getter is blocked', async () => {
    const target = document.createElement('section');
    target.dataset.tour = 'dashboard-overview';
    target.textContent = 'Seeded restaurant dashboard';
    document.body.append(target);
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<DemoToolbar seatName="Sales seat one" />);

    fireEvent.click(screen.getByRole('button', { name: 'Start tour' }));
    expect(await screen.findByRole('dialog', { name: 'Chain overview' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Chain overview' })).not.toBeInTheDocument()
    );
    target.remove();
  });
});
