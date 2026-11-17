// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';

const { signInPlatformActor } = vi.hoisted(() => ({ signInPlatformActor: vi.fn() }));
vi.mock('./e2e/fixtures/restaurant-platform-auth', () => ({ signInPlatformActor }));
import { actorFixture, signInAs } from './e2e/fixtures/restaurant-actor-accessibility';

it('routes the restaurant SuperAdmin through MFA before awaiting the authenticated destination', async () => {
  const waitForURL = vi.fn(async (_url: string | RegExp, _options?: unknown) => undefined);
  const page = {
    goto: vi.fn(async () => undefined),
    getByLabel: () => ({ fill: vi.fn() }),
    getByRole: () => ({ click: vi.fn() }),
    locator: () => ({
      fill: vi.fn(),
      first: () => ({ waitFor: () => new Promise(() => {}), isVisible: async () => false }),
    }),
    waitForURL,
    waitForLoadState: vi.fn(),
    url: () => 'http://admin.localhost:4319/platform',
  } as unknown as Page;
  signInPlatformActor.mockImplementation(async (_page: Page, _email: string) => {
    expect(waitForURL).not.toHaveBeenCalled();
  });
  expect(await signInAs(page, 'superAdmin')).toBe('http://admin.localhost:4319');
  expect(signInPlatformActor).toHaveBeenCalledExactlyOnceWith(page, actorFixture.superAdmin.email);
  expect(waitForURL).toHaveBeenCalled();
});
();
});
