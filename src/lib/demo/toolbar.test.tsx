// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoToolbar } from './toolbar';
import { DEMO_TOUR_STORAGE_KEY, saveTourProgress } from './tour';
import { DEMO_PERSONAS, demoPersonaEmail, demoPersonaUserId, type DemoPersona } from './personas';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  reload: vi.fn(),
  session: vi.fn(),
  pathname: '/dashboard',
}));

vi.mock('next-auth/react', () => ({ useSession: mocks.session }));
vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));

function signedIn(persona: DemoPersona, seat = 1) {
  mocks.session.mockReturnValue({
    status: 'authenticated',
    data: {
      user: {
        organizationId: `org_demo_restaurant_seat_${seat}`,
        id: demoPersonaUserId(seat, persona),
        email: demoPersonaEmail(seat, persona),
      },
    },
  });
}

const managerScope = `org_demo_restaurant_seat_1:${demoPersonaUserId(1, 'manager')}`;
const managerStorageKey = `${DEMO_TOUR_STORAGE_KEY}:${managerScope}`;

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
    mocks.pathname = '/dashboard';
    signedIn('manager');
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
    expect(sessionStorage.getItem(managerStorageKey)).not.toBeNull();

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
    expect(sessionStorage.getItem(managerStorageKey)).toBeNull();
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

  it.each(['cashier', 'waiter', 'kitchen', 'inventory', 'finance'] as const)(
    'shows the signed-in %s guide without reset controls',
    async (persona) => {
      signedIn(persona);
      render(<DemoToolbar seatName="Sales seat one" />);
      expect(screen.getByText(`Sales seat one · ${DEMO_PERSONAS[persona].label}`)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Reset my seat' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Change perspective' })).toHaveAttribute(
        'href',
        '/demo/restaurants'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Sales script' }));
      expect(
        await screen.findByRole('dialog', { name: `${DEMO_PERSONAS[persona].label} demo guide` })
      ).toBeVisible();
      expect(screen.getByText(/Card processing, receipt printers/)).toBeVisible();
      expect(screen.getByText(/Changing perspective signs in again/)).toBeVisible();
    }
  );

  it('does not resume manager progress or prepare manager actions for kitchen', async () => {
    saveTourProgress(sessionStorage, 7, managerScope);
    signedIn('kitchen');
    mocks.pathname = '/kds';
    const target = document.createElement('section');
    target.dataset.tour = 'kds-ticket';
    target.textContent = 'Order 101 · Fire';
    const action = document.createElement('button');
    action.textContent = 'Prepare';
    const onAction = vi.fn();
    action.onclick = onAction;
    target.append(action);
    document.body.append(target);
    render(<DemoToolbar seatName="Sales seat one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start tour' }));
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeVisible();
    expect(screen.getByText('Kitchen · Step 1 of 1')).toBeVisible();
    expect(onAction).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(sessionStorage.getItem(managerStorageKey)).not.toBeNull();
    target.remove();
  });

  it('drops an active guide immediately when the authenticated account changes', async () => {
    const target = document.createElement('section');
    target.dataset.tour = 'dashboard-overview';
    target.textContent = 'Seeded dashboard';
    document.body.append(target);
    const view = render(<DemoToolbar seatName="Sales seat one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start tour' }));
    await screen.findByRole('button', { name: 'Next' });
    signedIn('waiter');
    view.rerender(<DemoToolbar seatName="Sales seat one" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset my seat' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start tour' })).toBeVisible();
    target.remove();
  });

  it('resolves an authenticated seat above the server default without reading server configuration', () => {
    signedIn('kitchen', 6);
    render(<DemoToolbar seatName="Sales seat six" />);
    expect(screen.getByText('Sales seat six · Kitchen')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start tour' })).toBeVisible();
  });

  it.each(['loading', 'unauthenticated', 'unknown', 'revoked'])(
    'does not offer manager controls for a %s session',
    (state) => {
      mocks.session.mockReturnValue({
        status:
          state === 'loading' ? 'loading' : state === 'unauthenticated' ? state : 'authenticated',
        data: {
          user: {
            id: state === 'revoked' ? demoPersonaUserId(1, 'manager') : 'unrecognized-user',
            email: demoPersonaEmail(1, 'manager'),
            organizationId: 'org_demo_restaurant_seat_1',
            sessionRevoked: state === 'revoked',
          },
        },
      });
      render(<DemoToolbar seatName="Sales seat one" />);
      expect(screen.queryByRole('button', { name: 'Start tour' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reset my seat' })).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(
        state === 'loading' ? 'Loading' : 'unavailable'
      );
    }
  );
});
