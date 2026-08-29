import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import {
  actorViewports,
  assertAccessiblePage,
  assertNoRawIds,
  captureEvidence,
  evidenceDirectory,
  missingActorEnvironment,
  mockOperatorTerminal,
  signInActor,
  type BrowserActor,
} from './fixtures/restaurant-actor-accessibility';

test.beforeAll(async () => mkdir(evidenceDirectory, { recursive: true }));

const actorRows: ReadonlyArray<{
  actor: BrowserActor;
  allowedPath: string;
  allowedHeading: RegExp;
  deniedPath: string;
}> = [
  {
    actor: 'superadmin',
    allowedPath: '/platform/organizations',
    allowedHeading: /organizations/i,
    deniedPath: '/restaurant/catalog',
  },
  {
    actor: 'agency',
    allowedPath: '/dashboard',
    allowedHeading: /dashboard|good/i,
    deniedPath: '/restaurant/catalog',
  },
  {
    actor: 'restaurant-admin',
    allowedPath: '/restaurant/catalog',
    allowedHeading: /catalog/i,
    deniedPath: '/clients',
  },
];

for (const row of actorRows) {
  for (const viewport of actorViewports) {
    test(`${row.actor} ${viewport.name}: allowed smoke, denied cross-vertical route, keyboard and accessibility`, async ({
      page,
    }) => {
      const missing = missingActorEnvironment(row.actor);
      test.skip(Boolean(missing), `WHA-309 external actor fixture unavailable: ${missing}`);
      await page.setViewportSize(viewport);
      const baseURL = await signInActor(page, row.actor);

      await page.goto(`${baseURL}${row.allowedPath}`);
      await assertAccessiblePage(page, row.allowedHeading);
      await assertNoRawIds(page);
      await captureEvidence(page, row.actor, viewport.name);

      await page.goto(`${baseURL}${row.deniedPath}`);
      await expect(page).not.toHaveURL(new RegExp(`${row.deniedPath.replace('/', '\\/')}$`));
      await expect(
        page
          .getByText(/permission denied|not available|not found|access denied/i)
          .or(page.getByRole('heading', { name: /dashboard|organizations/i }))
      ).toBeVisible();
    });
  }
}

for (const viewport of actorViewports) {
  test(`restaurant operator ${viewport.name}: loading, empty, error recovery, focus, names, states, and no raw IDs`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockOperatorTerminal(page);

    await page.goto('/pos');
    await expect(page.getByRole('button', { name: 'Establish session' })).toBeDisabled();
    await expect(page.getByLabel('Bearer device secret')).toHaveAccessibleName(
      'Bearer device secret'
    );
    await page.getByLabel('Bearer device secret').fill('local-device-secret');
    await page.getByRole('button', { name: 'Establish session' }).click();
    await page.getByLabel('Operator profile ID').fill('local-operator');
    await page.getByLabel('Operator PIN').fill('424242');
    await page.getByRole('button', { name: 'Unlock terminal' }).click();
    await expect(page.getByText(/no open orders/i)).toBeVisible();
    await assertAccessiblePage(page, /order pad/i);
    await captureEvidence(page, 'restaurant-operator-pos', viewport.name);
    await assertNoRawIds(page);

    await page.goto('/kds');
    await page.getByLabel('Bearer device secret').fill('local-device-secret');
    await page.getByLabel('Acting operator profile ID').fill('local-operator');
    await page.getByRole('button', { name: 'Connect display' }).click();
    await expect(page.getByRole('alert')).toContainText('Kitchen queue unavailable');
    await page.getByRole('button', { name: /retry/i }).click();
    await expect(page.getByText(/queue clear|no open kitchen tickets/i)).toBeVisible();
    await assertAccessiblePage(page, /kitchen floor/i);
    await captureEvidence(page, 'restaurant-operator-kds', viewport.name);
    await assertNoRawIds(page);
  });
}

test('RTL launch-language acceptance is NOT-RUN/External pending D20', async () => {
  test.skip(true, 'D20 does not name a launch language; RTL remains NOT-RUN/External.');
});
