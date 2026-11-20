import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  headers: vi.fn(),
  shared: vi.fn(),
  organization: vi.fn(),
  tenantDb: vi.fn(),
  entitlements: vi.fn(),
  connections: vi.fn(),
  signIn: vi.fn(),
  replace: vi.fn(),
  redirect: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  redirect: mocks.redirect,
}));
vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/host', () => ({
  resolveOrganizationByHost: mocks.organization,
  TENANT_HOST_HEADER: 'x-devfathom-host',
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ isSharedHost: mocks.shared }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.tenantDb }));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: mocks.entitlements }));

import LoginPage from '@/app/login/page';
import RegisterPage from '@/app/login/register/page';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.actor.mockResolvedValue(null);
  mocks.headers.mockResolvedValue(new Headers({ host: 'pharmacy.localhost' }));
  mocks.shared.mockReturnValue(false);
  mocks.organization.mockResolvedValue({ id: 'pharmacy-tenant', vertical: 'PHARMACY' });
  mocks.entitlements.mockResolvedValue({ enabledModules: ['identity'] });
  mocks.connections.mockResolvedValue([]);
  mocks.tenantDb.mockImplementation((_id, run) =>
    run({ organizationIdentityConnection: { findMany: mocks.connections } })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function registration() {
  render(await RegisterPage({ searchParams: Promise.resolve({ vertical: 'pharmacy' }) }));
}

describe('pharmacy sign-in, mockup screen 1', () => {
  it('renders the pharmacy composition while keeping tenant precedence and the native callback', async () => {
    render(
      await LoginPage({
        searchParams: Promise.resolve({
          vertical: 'restaurant',
          callbackUrl: '/pharmacy/counter?branch=branch-1',
        }),
      })
    );
    expect(
      screen.getByRole('complementary', { name: 'DevFathom for pharmacies' })
    ).toBeInTheDocument();
    expect(screen.getByText('Know every')).toBeInTheDocument();
    expect(screen.getByText('Receipt 0418')).toBeInTheDocument();
    expect(screen.getByText('Sample data')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Register your pharmacy/ })).toHaveAttribute(
      'href',
      '/login/register?vertical=pharmacy'
    );
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!;
    expect(form).toHaveAttribute('action', '/login/submit');
    expect(form).toHaveAttribute('method', 'post');
    expect(selectFieldControl(form.querySelector('[name="callbackUrl"]'))).toHaveValue(
      '/pharmacy/counter?branch=branch-1'
    );
    expect(mocks.tenantDb).toHaveBeenCalledWith('pharmacy-tenant', expect.any(Function));
  });

  it('retains credentials, errors, loading, MFA and the requested counter destination', async () => {
    mocks.signIn.mockResolvedValueOnce({ error: 'CredentialsSignin', code: '2fa_required' });
    render(
      await LoginPage({
        searchParams: Promise.resolve({ callbackUrl: '/pharmacy/counter?branch=branch-1' }),
      })
    );
    fireEvent.change(selectFieldControl(screen.getByLabelText('Email', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'owner@pharmacy.pk' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'existing-password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText('Authentication code', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(selectFieldControl(screen.getByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('existing-password');
    expect(code).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(selectFieldControl(code), { target: { value: 'recovery-code' } });
    let complete!: (value: { ok: boolean }) => void;
    mocks.signIn.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    complete({ ok: true });
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith('/pharmacy/counter?branch=branch-1')
    );
    expect(mocks.signIn).toHaveBeenLastCalledWith('credentials', {
      email: 'owner@pharmacy.pk',
      password: 'existing-password',
      totp: 'recovery-code',
      redirect: false,
    });
  });

  it('keeps enforced tenant SSO exclusive', async () => {
    mocks.connections.mockResolvedValue([
      { id: 'identity-1', name: 'Pharmacy identity', protocol: 'OIDC', enforceSso: true },
    ]);
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with Pharmacy identity' })).toHaveAttribute(
      'href',
      '/api/sso/oidc/identity-1/start'
    );
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('keeps shared-host workspace selection and its callback destination', async () => {
    mocks.shared.mockReturnValue(true);
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: 'select',
          organizations: [
            {
              id: 'first',
              displayName: 'First pharmacy',
              slug: 'first',
              ssoEnforced: false,
              ssoConnections: [],
            },
            {
              id: 'second',
              displayName: 'Second pharmacy',
              slug: 'second',
              ssoEnforced: false,
              ssoConnections: [],
            },
          ],
        }),
        { status: 200 }
      )
    );
    render(
      await LoginPage({
        searchParams: Promise.resolve({ vertical: 'pharmacy', callbackUrl: '/pharmacy/counter' }),
      })
    );
    fireEvent.change(selectFieldControl(screen.getByLabelText('Email', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'owner@pharmacy.pk' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'existing-password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Where to?' });
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({
        body: JSON.stringify({
          email: 'owner@pharmacy.pk',
          password: 'existing-password',
          callbackUrl: '/pharmacy/counter',
        }),
      })
    );
    expect(screen.getByRole('button', { name: /First pharmacy/ })).toBeInTheDocument();
    expect(mocks.organization).not.toHaveBeenCalled();
  });
});

describe('pharmacy registration, mockup screen 2', () => {
  it('shows the licensed-premises guide and all existing intake groups without creating an account', async () => {
    await registration();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Register your pharmacy' })).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: 'What registration covers' })
    ).toHaveTextContent('Licensed before the');
    expect(screen.getByText('After activation')).toBeInTheDocument();
    expect(screen.getByText('Owner account')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('group')
        .map(
          (group) =>
            within(group).getByText(
              /^(Pharmacy|Drug sale licence|Pharmacist on record|Your account)$/,
              { selector: 'legend' }
            ).textContent
        )
    ).toEqual(['Pharmacy', 'Drug sale licence', 'Pharmacist on record', 'Your account']);
    expect(screen.getByLabelText('Legal business name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeRequired();
    expect(screen.getByLabelText('Licence copy', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('accept', '.pdf,.jpg,.jpeg,.png');
    expect(screen.getByLabelText('Licence copy', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeRequired();
    expect(screen.getByRole('textbox', { name: /^NTN/ })).not.toBeRequired();
    expect(screen.getByText('Printed on customer receipts.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Your account will be created by invitation after approval/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?vertical=pharmacy'
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('posts the existing multipart payload and preserves fields and selected licence on rejection', async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await registration();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Legal business name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Local pharmacy' },
    });
    const licence = new File(['%PDF-1.7'], 'licence.pdf', { type: 'application/pdf' });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Licence copy', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { files: [licence] } });
    expect(screen.getByText('licence.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    const form = screen.getByRole('button', { name: 'Request workspace' }).closest('form')!;
    fireEvent.submit(form);
    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Saving your request…' })).toBeDisabled();
    expect(screen.getByLabelText('Licence copy', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
    const [url, request] = mocks.fetch.mock.calls[0];
    expect(url).toBe('/api/workspace-requests');
    expect(request.method).toBe('POST');
    expect(request.body.get('vertical')).toBe('pharmacy');
    expect(request.body.get('companyName')).toBe('Local pharmacy');
    expect(request.body.get('authorized')).toBe('on');
    expect(request.body.has('password')).toBe(false);
    expect(request.body.has('licenceCopy')).toBe(true);
    finish(
      new Response(
        JSON.stringify({
          error: 'Review the highlighted fields.',
          fields: {
            companyName: ['Use the licensed name.'],
            province: ['Choose your province.'],
            licenceCopy: ['Upload a readable copy.'],
          },
        }),
        { status: 400 }
      )
    );
    await screen.findByRole('alert');
    expect(selectFieldControl(screen.getByLabelText('Legal business name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('Local pharmacy');
    expect(screen.getByText('licence.pdf')).toBeInTheDocument();
    for (const label of ['Legal business name', 'Province', 'Licence copy']) {
      expect(screen.getByLabelText(label, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText(label, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('aria-describedby');
    }
    expect(screen.getByRole('button', { name: 'Request workspace' })).toBeEnabled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('shows pending review only after the request has been saved', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending', id: 'request-1' }), { status: 201 })
    );
    await registration();
    fireEvent.submit(screen.getByRole('button', { name: 'Request workspace' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Pending approval');
    expect(status).toHaveTextContent('Reference: request-1');
    expect(status).toHaveTextContent('Your account invitation follows approval.');
    expect(screen.queryByRole('button', { name: 'Request workspace' })).not.toBeInTheDocument();
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('retains entered values and enables retry after a network error', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'));
    await registration();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Work email', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'owner@pharmacy.pk' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Request workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check your connection and try again.'
    );
    expect(selectFieldControl(screen.getByLabelText('Work email', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('owner@pharmacy.pk');
    expect(screen.getByRole('button', { name: 'Request workspace' })).toBeEnabled();
  });

  it('leaves other workspace presentations and chooser gates intact', async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: 'app.localhost' }));
    render(await RegisterPage({ searchParams: Promise.resolve({ vertical: 'agency' }) }));
    expect(screen.getByRole('navigation', { name: 'Workspace type' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request workspace' })).not.toBeInTheDocument();
    expect(screen.getByRole('main').parentElement?.className).not.toMatch(/pharmacy/);
  });
});
