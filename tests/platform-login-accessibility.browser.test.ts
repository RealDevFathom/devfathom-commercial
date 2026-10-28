// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseURL = process.env.PLATFORM_QA_BASE_URL;
const platformLoginURL = baseURL
  ? new URL('/platform/login', baseURL.replace('://127.0.0.1', '://admin.localhost'))
  : null;
let browser: Browser;

function luminance(color: string) {
  const channels = color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number)
    .map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

// Explicit opt-in keeps this browser lane out of ordinary unit test runs.
describe.runIf(Boolean(baseURL))('platform login Studio accessibility', () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox'],
    });
    mkdirSync('playwright-artifacts/platform-login', { recursive: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const width of [375, 768, 1024, 1440]) {
    for (const theme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        it(`${width}px ${theme} ${reducedMotion}`, async () => {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            reducedMotion,
            // Next.js derives x-forwarded-host from its listening address in
            // this local lane. Model the admin-facing proxy authority explicitly.
            extraHTTPHeaders: { 'x-forwarded-host': platformLoginURL!.host },
          });
          try {
            await context.addInitScript((value) => localStorage.setItem('theme', value), theme);
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('console', (message) => {
              if (message.type() === 'error') errors.push(message.text());
            });
            const mfaProbes: string[] = [];
            page.on('request', (request) => {
              if (new URL(request.url()).pathname === '/api/platform/mfa')
                mfaProbes.push(request.method());
            });
            await page.goto(platformLoginURL!.href);
            await page.getByLabel('Work email').waitFor();
            await page.waitForFunction(() =>
              document
                .getAnimations()
                .every(
                  (a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity
                )
            );
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
            ).toBe(true);
            // axe does not consistently inspect placeholders; measure their real
            // browser-resolved colors against the actual input surface as well.
            const colors = await page.locator('input[placeholder]').evaluateAll((inputs) =>
              inputs.map((input) => ({
                text: getComputedStyle(input, '::placeholder').color,
                background: getComputedStyle(input).backgroundColor,
              }))
            );
            for (const color of colors) {
              const values = [luminance(color.text), luminance(color.background)].sort(
                (a, b) => b - a
              );
              expect((values[0]! + 0.05) / (values[1]! + 0.05)).toBeGreaterThanOrEqual(4.5);
            }
            const results = await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
              .analyze();
            expect(
              results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }))
            ).toEqual([]);
            await page.screenshot({
              path: `playwright-artifacts/platform-login/${width}-${theme}-${reducedMotion}.png`,
              fullPage: true,
            });
            expect(errors).toEqual([]);
            expect(mfaProbes).toEqual([]);
          } finally {
            await context.close();
          }
        }, 60_000);
      }
    }
  }
});
