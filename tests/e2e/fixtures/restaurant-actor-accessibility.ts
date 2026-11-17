import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { signInPlatformActor } from './restaurant-platform-auth';

export type ActorKey = 'superAdmin' | 'agency' | 'restaurantAdmin' | 'restaurantOperator';

type Actor = {
  email: string;
  password: string;
  loginPath: '/login' | '/platform/login';
  host?: 'admin.localhost' | 'app.localhost' | 'chai-chowk.localhost';
  workspace?: RegExp;
};

const value = (name: string) => process.env[name] ?? '';

function actorBaseUrl(host?: Actor['host']) {
  const url = new URL(
    process.env.PLAYWRIGHT_BASE_URL ??
      `http://localhost:${Number(process.env.PLAYWRIGHT_PORT ?? 4319)}`
  );
  if (host) url.hostname = host;
  return url;
}

export const actorFixture: Record<ActorKey, Actor> = {
  superAdmin: {
    email: value('RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL'),
    password: value('RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD'),
    loginPath: '/platform/login',
    host: 'admin.localhost',
  },
  agency: {
    email: value('RESTAURANT_ACTOR_AGENCY_EMAIL'),
    password: value('RESTAURANT_ACTOR_AGENCY_PASSWORD'),
    loginPath: '/login',
    host: 'app.localhost',
    workspace: /DevFathom/i,
  },
  restaurantAdmin: {
    email: value('RESTAURANT_ACTOR_ADMIN_EMAIL'),
    password: value('RESTAURANT_ACTOR_ADMIN_PASSWORD'),
    loginPath: '/login',
    host: 'chai-chowk.localhost',
    workspace: /Chai Chowk Café|chai-chowk/i,
  },
  restaurantOperator: {
    email: value('RESTAURANT_ACTOR_OPERATOR_EMAIL'),
    password: value('RESTAURANT_ACTOR_OPERATOR_PASSWORD'),
    loginPath: '/login',
    host: 'chai-chowk.localhost',
    workspace: /Chai Chowk Café|chai-chowk/i,
  },
};

export const actorFixtureReady = Object.values(actorFixture).every(
  ({ email, password }) => email.length > 0 && password.length > 0
);

/**
 * The owner URL is used only to inspect the disposable fixture. The application
 * and browser server must use RESTAURANT_ACTOR_RUNTIME_DATABASE_URL.
 */
export async function assertDisposableDatabaseRoles() {
  const ownerUrl = value('RESTAURANT_ACTOR_OWNER_DATABASE_URL');
  const runtimeUrl = value('RESTAURANT_ACTOR_RUNTIME_DATABASE_URL');
  if (!ownerUrl || !runtimeUrl)
    throw new Error('Disposable owner and runtime database URLs are required.');

  const runtimeRole = decodeURIComponent(new URL(runtimeUrl).username);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const result = await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [
      runtimeRole,
    ]);
    expect(result.rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);
  } finally {
    await client.end();
  }
}

export async function completeWorkspaceSelection(
  page: Page,
  loginPath: Actor['loginPath'],
  workspace: RegExp
) {
  const chooser = page.getByText('Choose a workspace', { exact: true });
  const authAlert = authenticationAlert(page);
  const outcome = await Promise.race([
    chooser.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'chooser' as const),
    page
      .waitForURL((url) => isAuthenticatedAppDestination(url, loginPath), { timeout: 60_000 })
      .then(() => 'navigation' as const),
    page
      .waitForURL((url) => url.pathname === '/api/auth/error', { timeout: 60_000 })
      .then(() => 'auth-error' as const),
    authAlert.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'auth-alert' as const),
  ]);
  if (outcome === 'auth-error' || outcome === 'auth-alert') {
    const message = (await authAlert.isVisible().catch(() => false))
      ? (await authAlert.textContent())?.trim()
      : undefined;
    throw new Error(`Authentication failed${message ? `: ${message}` : ` at ${page.url()}`}`);
  }
  if (outcome === 'chooser') await page.getByRole('button', { name: workspace }).click();
  return { chooser, outcome };
}

export function authenticationAlert(page: Page) {
  return page.locator('[role="alert"].text-destructive:not(#__next-route-announcer__)').first();
}

export function isAuthenticatedAppDestination(url: URL, loginPath: Actor['loginPath']) {
  return (
    url.pathname !== loginPath &&
    url.pathname !== '/login' &&
    url.pathname !== '/platform/login' &&
    url.pathname !== '/api/auth/error' &&
    !url.pathname.startsWith('/api/auth/')
  );
}

async function waitForAuthenticatedApp(page: Page, loginPath: Actor['loginPath']) {
  try {
    const alert = authenticationAlert(page);
    const outcome = await Promise.race([
      page
        .waitForURL((url) => isAuthenticatedAppDestination(url, loginPath), { timeout: 60_000 })
        .then(() => 'destination' as const),
      page
        .waitForURL((url) => url.pathname === '/api/auth/error', { timeout: 60_000 })
        .then(() => 'auth-error' as const),
      alert.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'auth-alert' as const),
    ]);
    if (outcome !== 'destination') {
      const message = (await alert.isVisible().catch(() => false))
        ? (await alert.textContent())?.trim()
        : undefined;
      throw new Error(`Authentication failed${message ? `: ${message}` : ` at ${page.url()}`}`);
    }
    await page.waitForLoadState('domcontentloaded');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Authentication failed')) throw error;
    const alert = authenticationAlert(page);
    if (await alert.isVisible().catch(() => false)) {
      const message = (await alert.textContent())?.trim();
      throw new Error(`Authentication failed${message ? `: ${message}` : '.'}`, { cause: error });
    }
    throw error;
  }
}

export async function signInAs(page: Page, key: ActorKey) {
  const actor = actorFixture[key];
  await page.goto(new URL(actor.loginPath, actorBaseUrl(actor.host)).href);
  await page.getByLabel(/email/i).fill(actor.email);
  await page.locator('input[name="password"]').fill(actor.password);
  if (actor.loginPath === '/platform/login') {
    await signInPlatformActor(page, actor.email);
  } else {
    const password = page.locator('input[name="password"]');
    await expect(password).toHaveAttribute('type', 'password');
    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: 'Show password' }).click();
          return password.getAttribute('type');
        },
        { timeout: 60_000, intervals: [250, 500, 1000] }
      )
      .toBe('text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  if (actor.workspace) {
    const { chooser, outcome } = await completeWorkspaceSelection(
      page,
      actor.loginPath,
      actor.workspace
    );
    if (key === 'agency' && outcome === 'chooser') await expect(chooser).toBeHidden();
  }
  await waitForAuthenticatedApp(page, actor.loginPath);
  if (key === 'agency') expect(new URL(page.url()).pathname).not.toBe('/login');
  return new URL(page.url()).origin;
}

export async function assertNoRawDatabaseIds(page: Page) {
  await expect(page.locator('body')).not.toContainText(
    /\b(?:org|user|branch|staff|device)_[a-z0-9_-]{6,}\b/i
  );
  expect(new URL(page.url()).search).not.toMatch(/(?:organization|branch|staff|device)Id=/i);
}
