// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoRestaurantEntryClient } from './demo-entry-client';
import DemoLayout, { metadata } from '../layout';
import RestaurantDemoPage, { dynamic } from './page';
import { DEMO_PERSONA_KEYS, DEMO_PERSONAS } from '@/lib/demo/personas';

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
      {
        seat: 1,
        name: 'Sales seat one',
        ready: true,
        personas: DEMO_PERSONA_KEYS.map((key) => ({ key, ready: true })),
      },
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
    expect(screen.queryByRole('radio', { name: /Sales seat/ })).not.toBeInTheDocument();
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
    expect(screen.getByText(/Returning to this seat with a valid access grant/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid access code.');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      code: '',
      seat: 1,
      persona: 'manager',
    });
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
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      code: '',
      seat: 1,
      persona: 'manager',
    });
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

  it.each(DEMO_PERSONA_KEYS)(
    'signs in the real %s account and prepares only its terminal kind',
    async (persona) => {
      const metadata = DEMO_PERSONAS[persona];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(seats())
        .mockResolvedValueOnce(
          json({
            organizationId: 'demo-org-1',
            persona,
            callbackUrl: metadata.callbackUrl,
          })
        )
        .mockResolvedValueOnce(json({ ready: true }));
      vi.stubGlobal('fetch', fetchMock);
      mocks.signIn.mockResolvedValue({ ok: true, error: null });
      render(<DemoRestaurantEntryClient />);
      await screen.findByText('Sales seat one');
      expect(screen.getByRole('radio', { name: 'Manager' })).toBeChecked();
      fireEvent.click(screen.getByRole('radio', { name: metadata.label }));
      fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'shared-code' } });
      fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));
      await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(metadata.callbackUrl));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        code: 'shared-code',
        seat: 1,
        persona,
      });
      expect(mocks.signIn).toHaveBeenCalledWith('login-intent', {
        organizationId: 'demo-org-1',
        redirect: false,
        callbackUrl: metadata.callbackUrl,
      });
      expect(mocks.refresh).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(metadata.deviceKind ? 3 : 2);
      if (metadata.deviceKind)
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ kind: metadata.deviceKind });
    }
  );

  it.each([
    'https://example.com',
    '//example.com',
    'javascript:alert(1)',
    '/dashboard?next=/pos',
    '/kds',
  ])('rejects an unexpected landing path: %s', async (callbackUrl) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(seats())
        .mockResolvedValueOnce(json({ organizationId: 'demo-org-1', callbackUrl }))
    );
    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Sales seat one');
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Demo access returned an invalid response.'
    );
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('rejects another persona even when its landing path matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(seats())
        .mockResolvedValueOnce(
          json({ organizationId: 'demo-org-1', persona: 'owner', callbackUrl: '/dashboard' })
        )
    );
    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Sales seat one');
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response');
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('locks choices during login, then retains inputs after a sign-in failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(seats())
        .mockResolvedValueOnce(
          json({ organizationId: 'demo-org-1', persona: 'kitchen', callbackUrl: '/kds' })
        )
    );
    let finish!: (value: { error: string }) => void;
    mocks.signIn.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Sales seat one');
    fireEvent.click(screen.getByRole('radio', { name: 'Kitchen' }));
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'preserved-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));
    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Manager' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Sales seat one/ })).toBeDisabled();
    finish({ error: 'CredentialsSignin' });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be signed in');
    expect(screen.getByRole('radio', { name: 'Kitchen' })).toBeChecked();
    expect(screen.getByLabelText('Access code')).toHaveValue('preserved-code');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('keeps a failed device preparation on entry with an actionable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(seats())
        .mockResolvedValueOnce(json({ organizationId: 'demo-org-1', callbackUrl: '/dashboard' }))
        .mockResolvedValueOnce(json({ error: 'Demo terminal is not ready.' }, 409))
    );
    mocks.signIn.mockResolvedValue({ ok: true });
    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Sales seat one');
    fireEvent.click(screen.getByRole('button', { name: 'Enter restaurant demo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Demo terminal is not ready.');
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeEnabled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('disables unprepared personas and supports the original manager-only seat response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ seats: [{ seat: 1, name: 'Legacy seat', ready: true }] }))
    );
    render(<DemoRestaurantEntryClient />);
    await screen.findByText('Legacy seat');
    expect(screen.getByRole('radio', { name: 'Manager' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Kitchen (Unavailable)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeEnabled();
  });

  it('blocks an unavailable selected perspective after changing seats', async () => {
    const personas = DEMO_PERSONA_KEYS.map((key) => ({ key, ready: true }));
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        seats: [
          { seat: 1, name: 'First seat', ready: true, personas },
          {
            seat: 2,
            name: 'Second seat',
            ready: true,
            personas: personas.map((option) => ({ ...option, ready: option.key !== 'kitchen' })),
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<DemoRestaurantEntryClient />);
    await screen.findByText('First seat');
    fireEvent.click(screen.getByRole('radio', { name: 'Kitchen' }));
    fireEvent.click(screen.getByRole('radio', { name: /Second seat/ }));
    expect(screen.getByRole('radio', { name: 'Kitchen (Unavailable)' })).toBeDisabled();
    expect(screen.getByText(/Kitchen is not ready on this seat/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('offers a readiness refresh when every seat is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ seats: [{ seat: 1, name: 'Preparing seat', ready: false }] }))
        .mockResolvedValueOnce(seats())
    );
    render(<DemoRestaurantEntryClient />);
    expect(await screen.findByText(/No seats are ready yet/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry seat list' }));
    expect(await screen.findByRole('radio', { name: /Sales seat one/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeEnabled();
  });

  it('allows a ready kitchen account even when that seat’s manager is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          seats: [
            {
              seat: 1,
              name: 'Kitchen-ready seat',
              ready: false,
              personas: DEMO_PERSONA_KEYS.map((key) => ({ key, ready: key === 'kitchen' })),
            },
          ],
        })
      )
    );
    render(<DemoRestaurantEntryClient />);
    expect(await screen.findByRole('radio', { name: /Kitchen-ready seat/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Kitchen' }));
    expect(screen.getByRole('button', { name: 'Enter restaurant demo' })).toBeEnabled();
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
