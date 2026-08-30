import type { Page } from '@playwright/test';
import { describe, expect, test } from 'vitest';

import {
  completeWorkspaceSelection,
  isAuthenticatedAppDestination,
} from './e2e/fixtures/restaurant-actor-accessibility';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Restaurant actor workspace selection', () => {
  test('accepts only stable authenticated app destinations', () => {
    for (const pathname of ['/login', '/platform/login', '/api/auth/error', '/api/auth/callback']) {
      expect(
        isAuthenticatedAppDestination(new URL(`http://app.localhost${pathname}`), '/login')
      ).toBe(false);
    }
    expect(isAuthenticatedAppDestination(new URL('http://app.localhost/dashboard'), '/login')).toBe(
      true
    );
  });

  test('awaits a delayed chooser and selects Chai Chowk by stable identity', async () => {
    const chooserVisible = deferred();
    let selected: RegExp | undefined;
    const page = {
      getByText: () => ({ waitFor: () => chooserVisible.promise }),
      waitForURL: () => new Promise<void>(() => undefined),
      getByRole: (role: string, options?: { name: RegExp }) =>
        role === 'alert'
          ? {
              first: () => ({ waitFor: () => new Promise<void>(() => undefined) }),
            }
          : {
              click: async () => {
                selected = options?.name;
              },
            },
    } as unknown as Page;

    const result = completeWorkspaceSelection(page, '/login', /Chai Chowk Café|chai-chowk/i);
    chooserVisible.resolve();

    await expect(result).resolves.toMatchObject({ outcome: 'chooser' });
    expect(selected?.test('chai-chowk')).toBe(true);
  });

  test('preserves single-workspace auto-continue when navigation wins', async () => {
    let clicked = false;
    const page = {
      getByText: () => ({ waitFor: () => new Promise<void>(() => undefined) }),
      waitForURL: async (predicate: (url: URL) => boolean) => {
        expect(predicate(new URL('http://app.localhost/dashboard'))).toBe(true);
      },
      getByRole: (role: string) =>
        role === 'alert'
          ? {
              first: () => ({ waitFor: () => new Promise<void>(() => undefined) }),
            }
          : { click: async () => (clicked = true) },
    } as unknown as Page;

    await expect(
      completeWorkspaceSelection(page, '/login', /Chai Chowk Café|chai-chowk/i)
    ).resolves.toMatchObject({ outcome: 'navigation' });
    expect(clicked).toBe(false);
  });
});
