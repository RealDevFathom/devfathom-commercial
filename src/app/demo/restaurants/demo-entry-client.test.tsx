// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoRestaurantEntryClient } from './demo-entry-client';
import DemoLayout, { metadata } from '../layout';
import RestaurantDemoPage, { dynamic } from './page';

const mocks = vi.hoisted(() => ({
  isDemoEnabled: vi.fn(),
  notFound: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));

vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('@/lib/demo/config', () => ({ isDemoEnabled: mocks.isDemoEnabled }));

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function seats() {
  return json({
    seats: [
      { seat: 1, name: 'Sales seat one', ready: true },
      { seat: 2, name: 'Sales seat two', ready: false },
    ],
  });
}

describe('DemoRestaurantEntryClient', () => {
  beforeEach(() => {
    mocks.isDemoEnabled.mockReset().mockReturnValue(true);
    mocks.notFound.mockReset();
    mocks.replace.mockReset();
    mocks.refresh.mockReset();
    mocks.signIn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['a rejected fetch', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['an HTTP 500', () => Promise.resolve(json({ error: 'P1001 database unavailable' }, 500))],
  ])('normalizes %s and restores real seat readiness on retry', async (_failure, fail) => {
    const fetchMock = vi.fn().mockImplementationOnce(fail).mockResolvedValueOnce(seats());
    vi.stubGlobal('fetch', fetchMock);

    render(<DemoRestaurantEntryClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Presentation seats are unavailable\. Retry in a moment\.$/
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry seat list' }));

    expect(await screen.findByRole('radio', { name: /Sales seat one/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Sales seat two/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('submits blank reentry to the server and surfaces its rejection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(seats())
      .mockResolvedValueOnce(json({ error: 'Invalid access code.' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Sales seat one');
    expect(screen.getByText('Returning? Continue without re-entering your code.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid access code.');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ code: '', seat: 1 });
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('reenters with a valid server grant and no repeated code', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(seats())
      .mockResolvedValueOnce(json({ organizationId: 'demo-org-1', callbackUrl: '/dashboard' }))
      .mockResolvedValueOnce(json({ ready: true, branchId: 'demo-branch-1' }));
    vi.stubGlobal('fetch', fetchMock);
    mocks.signIn.mockResolvedValue({ ok: true, error: null });

    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Sales seat one');
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/dashboard'));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ code: '', seat: 1 });
    expect(mocks.signIn).toHaveBeenCalledWith('login-intent', {
      organizationId: 'demo-org-1',
      redirect: false,
      callbackUrl: '/dashboard',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/demo/restaurants/device-session',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('honors server rate limiting and blocks repeat access attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(seats())
      .mockResolvedValueOnce(json({ error: 'Too many attempts.', retryAfter: 12 }, 429));
    vi.stubGlobal('fetch', fetchMock);

    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Sales seat one');
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'retry-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));

    const blocked = await screen.findByRole('button', { name: 'Try again in 12s' });
    expect(blocked).toBeDisabled();
    fireEvent.click(blocked);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the demo page dynamic, private, gated, and wrapped without extra layout', () => {
    const child = <span>Demo child</span>;
    expect(dynamic).toBe('force-dynamic');
    expect(DemoLayout({ children: child })).toBe(child);
    expect(metadata).toMatchObject({
      title: 'Restaurant demo | DevFathom',
      robots: {
        index: false,
        follow: false,
        nocache: true,
        googleBot: { index: false, follow: false, noimageindex: true },
      },
    });
    expect(RestaurantDemoPage().type).toBe(DemoRestaurantEntryClient);

    mocks.isDemoEnabled.mockReturnValue(false);
    mocks.notFound.mockImplementationOnce(() => {
      throw new Error('NEXT_NOT_FOUND');
    });
    expect(() => RestaurantDemoPage()).toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });
});
