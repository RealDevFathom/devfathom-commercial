import type { Page } from '@playwright/test';
import { describe, expect, test } from 'vitest';

import {
  authenticationAlert,
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
      locator: () => ({ first: () => ({ waitFor: () => new Promise<void>(() => undefined) }) }),
      getByRole: (_role: string, options?: { name: RegExp }) => ({
        click: async () => {
          selected = options?.name;
        },
      }),
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
      locator: () => ({ first: () => ({ waitFor: () => new Promise<void>(() => undefined) }) }),
      getByRole: () => ({ click: async () => (clicked = true) }),
    } as unknown as Page;

    await expect(
      completeWorkspaceSelection(page, '/login', /Chai Chowk Café|chai-chowk/i)
    ).resolves.toMatchObject({ outcome: 'navigation' });
    expect(clicked).toBe(false);
  });

  test('ignores a visible Next route announcer when authenticated navigation succeeds', async () => {
    document.body.innerHTML = '<div id="__next-route-announcer__" role="alert">Dashboard</div>';
    let selectedElement: Element | null = null;
    const page = {
      getByText: () => ({ waitFor: () => new Promise<void>(() => undefined) }),
      waitForURL: async (predicate: (url: URL) => boolean) => {
        if (predicate(new URL('http://app.localhost/dashboard'))) return;
        return new Promise<void>(() => undefined);
      },
      locator: (selector: string) => ({
        first: () => ({
          waitFor: () => {
            selectedElement = document.querySelector(selector);
            return new Promise<void>(() => undefined);
          },
        }),
      }),
    } as unknown as Page;

    await expect(
      completeWorkspaceSelection(page, '/login', /Chai Chowk Café|chai-chowk/i)
    ).resolves.toMatchObject({ outcome: 'navigation' });
    expect(document.querySelector('#__next-route-announcer__')).not.toBeNull();
    expect(selectedElement).toBeNull();
  });

  test('skips the first route announcer and surfaces a later real auth alert', async () => {
    document.body.innerHTML = `
      <div id="__next-route-announcer__" role="alert">Login</div>
      <div role="alert" class="text-destructive">Invalid email or password.</div>
    `;
    const alertVisible = deferred();
    const page = {
      getByText: () => ({ waitFor: () => new Promise<void>(() => undefined) }),
      waitForURL: () => new Promise<void>(() => undefined),
      locator: (selector: string) => ({
        first: () => {
          const element = document.querySelector(selector);
          return {
            waitFor: () => alertVisible.promise,
            isVisible: async () => element !== null,
            textContent: async () => element?.textContent ?? null,
          };
        },
      }),
      url: () => 'http://app.localhost/login',
    } as unknown as Page;

    const result = completeWorkspaceSelection(page, '/login', /Chai Chowk Café|chai-chowk/i);
    alertVisible.resolve();

    await expect(result).rejects.toThrow('Authentication failed: Invalid email or password.');
    expect(authenticationAlert(page)).toBeDefined();
  });
});
