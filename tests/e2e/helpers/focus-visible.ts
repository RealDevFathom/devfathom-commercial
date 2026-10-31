import { expect, type Page, type TestInfo } from '@playwright/test';

export const focusThemes = ['light', 'dark'] as const;

const tabbableSelector = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

export async function useFocusTheme(page: Page, theme: (typeof focusThemes)[number]) {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((value) => {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      localStorage.setItem('theme', value);
    }
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
}

/**
 * Walk the document's real sequential focus order. This deliberately uses Tab
 * rather than calling focus(): :focus-visible only promises a keyboard cue.
 */
export async function assertKeyboardFocusWalk(page: Page, route: string, testInfo: TestInfo) {
  const candidates = page.locator(tabbableSelector);
  const candidateCount = await candidates.count();
  expect(candidateCount, `${route}: page must expose a keyboard-reachable control`).toBeGreaterThan(
    0
  );
  await expect(page.locator('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveCount(0);
  // Blurring an autofocused control alone leaves the sequential navigation
  // starting point there. Reset it to the start without focusing a control.
  await page.evaluate(() => {
    const body = document.body;
    const tabIndex = body.getAttribute('tabindex');
    body.setAttribute('tabindex', '-1');
    body.focus({ preventScroll: true });
    body.blur();
    if (tabIndex === null) body.removeAttribute('tabindex');
    else body.setAttribute('tabindex', tabIndex);
  });

  const readFocus = () =>
    page.evaluate(
      (selector) => ({
        index: [...document.querySelectorAll(selector)].indexOf(document.activeElement as Element),
        inBrowserChrome: document.activeElement === document.body && !document.hasFocus(),
      }),
      tabbableSelector
    );

  const visited = new Set<number>();
  let previousIndex = -1;
  for (let step = 0; step <= candidateCount; step += 1) {
    await page.keyboard.press('Tab');
    let focus = await readFocus();
    // Chromium visits browser chrome between the last and first document stop.
    // Re-enter the document and verify the cycle instead of treating body as a
    // control or accepting an arbitrary unknown focus target.
    if (focus.inBrowserChrome && visited.size > 0) {
      await page.keyboard.press('Tab');
      focus = await readFocus();
    }
    const { index } = focus;
    if (visited.has(index)) {
      expect(index, `${route}: focus cycles back to the first tab stop`).toBe([...visited][0]);
      break;
    }
    expect(
      index,
      `${route}: Tab must move to a declared interactive control`
    ).toBeGreaterThanOrEqual(0);
    expect(index, `${route}: Tab stops follow document order`).toBeGreaterThan(previousIndex);
    visited.add(index);
    previousIndex = index;
    const control = candidates.nth(index);
    await expect(control, `${route}: tab stop ${step + 1} follows sequential order`).toBeFocused();
    await expect(control, `${route}: tab stop ${step + 1} remains visible`).toBeVisible();

    const indicator = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      let surface: Element | null = element;
      let background = 'rgb(255, 255, 255)';
      while (surface) {
        const candidate = getComputedStyle(surface).backgroundColor;
        if (!candidate.endsWith(', 0)') && candidate !== 'transparent') {
          background = candidate;
          break;
        }
        surface = surface.parentElement;
      }
      return {
        focusVisible: element.matches(':focus-visible'),
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
        color: style.outlineColor,
        offset: Number.parseFloat(style.outlineOffset),
        background,
      };
    });
    expect(indicator.focusVisible, `${route}: tab stop ${step + 1} matches :focus-visible`).toBe(
      true
    );
    expect(indicator.style, `${route}: tab stop ${step + 1} has a solid outline`).toBe('solid');
    expect(
      indicator.width,
      `${route}: tab stop ${step + 1} outline is at least 2px`
    ).toBeGreaterThanOrEqual(2);
    expect(indicator.color, `${route}: tab stop ${step + 1} outline is painted`).not.toBe(
      'rgba(0, 0, 0, 0)'
    );
    expect(
      indicator.offset,
      `${route}: tab stop ${step + 1} outline avoids clipping`
    ).toBeLessThanOrEqual(0);
    expect(
      indicator.color,
      `${route}: tab stop ${step + 1} outline differs from its real surface`
    ).not.toBe(indicator.background);

    if (step === 0) {
      await testInfo.attach(`${route.replaceAll('/', '-') || 'root'}-focus`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }
  }
  expect(visited.size, `${route}: focus walk must visit at least one control`).toBeGreaterThan(0);
}
