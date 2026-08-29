import { expect, type Page } from '@playwright/test';
import pg from 'pg';

export type ActorKey = 'superAdmin' | 'agency' | 'restaurantAdmin' | 'restaurantOperator';

type Actor = {
  email: string;
  password: string;
  loginPath: '/login' | '/platform/login';
};

const value = (name: string) => process.env[name] ?? '';

export const actorFixture: Record<ActorKey, Actor> = {
  superAdmin: {
    email: value('RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL'),
    password: value('RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD'),
    loginPath: '/platform/login',
  },
  agency: {
    email: value('RESTAURANT_ACTOR_AGENCY_EMAIL'),
    password: value('RESTAURANT_ACTOR_AGENCY_PASSWORD'),
    loginPath: '/login',
  },
  restaurantAdmin: {
    email: value('RESTAURANT_ACTOR_ADMIN_EMAIL'),
    password: value('RESTAURANT_ACTOR_ADMIN_PASSWORD'),
    loginPath: '/login',
  },
  restaurantOperator: {
    email: value('RESTAURANT_ACTOR_OPERATOR_EMAIL'),
    password: value('RESTAURANT_ACTOR_OPERATOR_PASSWORD'),
    loginPath: '/login',
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

export async function signInAs(page: Page, key: ActorKey) {
  const actor = actorFixture[key];
  await page.goto(actor.loginPath);
  await page.getByLabel(/email/i).fill(actor.email);
  await page.locator('input[name="password"]').fill(actor.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => url.pathname !== actor.loginPath, { timeout: 60_000 });
}

export async function assertNoRawDatabaseIds(page: Page) {
  await expect(page.locator('body')).not.toContainText(
    /\b(?:org|user|branch|staff|device)_[a-z0-9_-]{6,}\b/i
  );
  expect(new URL(page.url()).search).not.toMatch(/(?:organization|branch|staff|device)Id=/i);
}
