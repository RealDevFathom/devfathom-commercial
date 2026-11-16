import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { expect } from 'vitest';

/** Real report markup + the current Studio shell geometry, with no tenant connection.
 * Requires Chromium (Playwright install or /usr/bin/chromium) and Poppler pdftotext.
 * No opt-out: clipping must fail the ordinary regression suite. */
export async function verifyReportPrint(markup: string) {
  const shell = readFileSync('src/components/layout/app-shell.tsx', 'utf8');
  const viewport = 'studio-viewport h-dvh overflow-hidden';
  const frame = 'studio-shell flex h-full min-w-0 flex-1 flex-col overflow-hidden';
  const canvas = 'studio-canvas relative min-h-0 flex-1 scroll-pt-24';
  for (const classes of [viewport, frame, canvas]) expect(shell).toContain(classes);
  expect(shell).toContain("counterPos ? 'overflow-hidden' : 'overflow-y-auto'");
  const css = await postcss([tailwind()]).process(readFileSync('src/app/globals.css', 'utf8'), {
    from: 'src/app/globals.css',
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox'],
  });
  try {
    const artifactDir = process.env.REPORT_ARTIFACT_DIR ?? 'playwright-artifacts/dev-61';
    mkdirSync(artifactDir, { recursive: true });
    for (const width of [375, 768, 1024, 1440]) {
      for (const theme of ['light', 'dark']) {
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${css.css}</style></head><body>
            <div class="${viewport}"><div class="${frame}">
              <header class="h-20 shrink-0">Synthetic workspace navigation</header>
              <main class="${canvas} overflow-y-auto"><div class="studio-stage mx-auto w-full min-h-full max-w-[1540px] px-4 py-4 sm:px-6 sm:py-6 xl:px-8 xl:pb-8">${markup}</div></main>
            </div></div></body></html>`);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
          ).toBe(true);
          expect(
            await page.locator('main').evaluate((el) => el.scrollHeight > el.clientHeight)
          ).toBe(true);
          await page.getByRole('button', { name: 'Print / Save as PDF' }).focus();
          expect(
            await page
              .getByRole('button', { name: 'Print / Save as PDF' })
              .evaluate((el) => document.activeElement === el)
          ).toBe(true);
          if (reducedMotion === 'no-preference') {
            await page.screenshot({ path: `${artifactDir}/${width}-${theme}.png` });
          }
          await page.emulateMedia({ media: 'print' });
          expect(
            await page.locator('[data-report-print]').evaluate((el) => ({
              color: getComputedStyle(el).color,
              background: getComputedStyle(el).backgroundColor,
            }))
          ).toEqual({ color: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)' });
          const pdf = await page.pdf({
            format: 'A4',
            path: `${artifactDir}/${width}-${theme}-${reducedMotion}.pdf`,
          });
          const extracted = spawnSync('pdftotext', ['-layout', '-', '-'], {
            input: pdf,
            encoding: 'utf8',
          });
          expect(extracted.error).toBeUndefined();
          expect(extracted.status).toBe(0);
          const text = extracted.stdout;
          expect(text).toContain('Selected period at a glance');
          expect(text).toContain('PKR 100.00');
          expect(text).toContain('Digest history');
          expect(text).toContain('No digests captured yet.');
          expect(text).not.toContain('Synthetic workspace navigation');
          expect(text).not.toContain('Print / Save as PDF');
          expect(text.split('\f').filter((part) => part.trim()).length).toBeGreaterThan(1);
          // Verify printable boxes fit the page width as well as surviving vertically.
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
          ).toBe(true);
          expect(errors).toEqual([]);
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}
