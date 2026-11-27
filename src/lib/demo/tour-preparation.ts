import { hasGramMillilitrePieceLines, tourTargetSelector, type DemoTourStep } from './tour';

const DEFAULT_TIMEOUT = 6_000;
const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="tab"], [role="option"]';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const CARD_SELECTOR = '[data-slot="section-card"], section, article';

export class TourPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TourPreparationError';
  }
}

function normalizedText(value: string | null | undefined) {
  return (
    value
      ?.replace(/[_\s]+/g, ' ')
      .trim()
      .toLowerCase() ?? ''
  );
}

function accessibleName(element: Element) {
  return normalizedText(element.getAttribute('aria-label') || element.textContent);
}

function isEnabled(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    !('disabled' in element && Boolean(element.disabled)) &&
    element.getAttribute('aria-disabled') !== 'true'
  );
}

export function isVisibleDemoElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor).display === 'none') {
      return false;
    }
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
  );
}

export function isUsableTourTarget(element: Element | null): element is HTMLElement {
  return isVisibleDemoElement(element) && normalizedText(element.textContent).length > 0;
}

function controls(scope: ParentNode) {
  return Array.from(scope.querySelectorAll(CONTROL_SELECTOR)).filter(
    (element): element is HTMLElement => isEnabled(element) && isVisibleDemoElement(element)
  );
}

function findNamedControl(scope: ParentNode, name: string) {
  const wanted = normalizedText(name);
  return controls(scope).find((element) => accessibleName(element) === wanted) ?? null;
}

function findHeadingCard(scope: ParentNode, name: string, exact = true) {
  const wanted = normalizedText(name);
  const heading = Array.from(scope.querySelectorAll(HEADING_SELECTOR)).find((element) => {
    if (!isVisibleDemoElement(element)) return false;
    const actual = normalizedText(element.textContent);
    return exact ? actual === wanted : actual.includes(wanted);
  });
  return heading?.closest<HTMLElement>(CARD_SELECTOR) ?? null;
}

function abortError() {
  return new DOMException('Tour preparation cancelled.', 'AbortError');
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(abortError());
      },
      { once: true }
    );
  });
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  message: string,
  signal?: AbortSignal,
  timeout = DEFAULT_TIMEOUT
) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw abortError();
    const value = read();
    if (value) return value;
    await delay(100, signal);
  }
  throw new TourPreparationError(message);
}

function targetFor(document: Document, step: DemoTourStep) {
  const target = document.querySelector(tourTargetSelector(step));
  return isUsableTourTarget(target) ? target : null;
}

async function waitForTarget(document: Document, step: DemoTourStep, signal?: AbortSignal) {
  return waitFor(
    () => targetFor(document, step),
    `Could not find visible seeded content for “${step.title}”. Confirm this demo seat is ready, then retry.`,
    signal
  );
}

async function preparePos(document: Document, step: DemoTourStep, signal?: AbortSignal) {
  const surface = await waitForTarget(document, step, signal);
  const modifierGroup = () =>
    Array.from(surface.querySelectorAll('[data-demo-modifier-group]')).find(isVisibleDemoElement);
  if (modifierGroup()) return surface;

  const error =
    'No enabled seeded menu item exposed its modifier choices. Select a menu item with modifiers, then retry.';
  const candidate = await waitFor(
    () =>
      controls(surface).find((control) =>
        control.matches('button[data-demo-modifier-item="true"]')
      ),
    error,
    signal
  );

  candidate.click();
  await waitFor(modifierGroup, error, signal);
  return surface;
}

async function selectFirstEnabledBranch(document: Document, error: string, signal?: AbortSignal) {
  const branch = await waitFor(
    () => {
      const control = Array.from(
        document.querySelectorAll('select, [data-select-field-trigger]')
      ).find(
        (element) =>
          accessibleName(element) === 'branch' &&
          isEnabled(element) &&
          isVisibleDemoElement(element)
      );
      const select =
        control instanceof HTMLSelectElement
          ? control
          : document.getElementById(control?.getAttribute('data-native-control') ?? '');
      if (!(select instanceof HTMLSelectElement) || !control) return null;
      const option = select
        ? Array.from(select.options).find(
            (option) => !option.disabled && option.value.trim().length > 0
          )
        : null;
      return option ? { control, select, option } : null;
    },
    error,
    signal
  );

  if (!branch.select.value) {
    if (branch.control === branch.select) {
      // Keep the server-rendered native fallback usable before enhancement.
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        branch.select,
        branch.option.value
      );
      branch.select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // Use the visible shared control so its selection/focus lifecycle runs too.
      (branch.control as HTMLElement).click();
      const option = await waitFor(
        () => {
          const popup = document.getElementById(branch.control.getAttribute('aria-controls') ?? '');
          return popup
            ? Array.from(popup.querySelectorAll<HTMLElement>('[role="option"]')).find(
                (candidate) =>
                  candidate.dataset.value === branch.option.value &&
                  isEnabled(candidate) &&
                  isVisibleDemoElement(candidate)
              )
            : null;
        },
        error,
        signal
      );
      option.click();
      await waitFor(() => branch.select.value === branch.option.value, error, signal);
    }
  }
}

async function prepareFloorTable(document: Document, step: DemoTourStep, signal?: AbortSignal) {
  await selectFirstEnabledBranch(
    document,
    'No enabled branch is available for the floor plan. Confirm this demo seat is ready, then retry.',
    signal
  );
  return waitForTarget(document, step, signal);
}

function openOrderControls(card: HTMLElement) {
  return controls(card).filter((control) => control.matches('button[aria-pressed]'));
}

async function prepareBill(document: Document, step: DemoTourStep, signal?: AbortSignal) {
  const existing = targetFor(document, step);
  if (existing) return existing;

  const openOrders = await waitFor(
    () => findHeadingCard(document, 'Open orders'),
    'Open orders is unavailable. Restore the seeded POS workspace, then retry.',
    signal
  );
  const candidates = await waitFor(
    () => {
      const values = openOrderControls(openOrders);
      return values.length ? values : null;
    },
    'No selectable seeded order is available. Reset this demo seat, then retry.',
    signal
  );
  for (const candidate of candidates) {
    const candidateName = accessibleName(candidate);
    const ready = await waitFor(
      () => (isEnabled(candidate) ? candidate : null),
      '',
      signal,
      1_200
    ).catch(() => null);
    if (!ready) continue;
    ready.click();
    const selected = await waitFor(
      () => {
        const currentOpenOrders = findHeadingCard(document, 'Open orders');
        return currentOpenOrders
          ? openOrderControls(currentOpenOrders).find(
              (control) =>
                accessibleName(control) === candidateName &&
                control.getAttribute('aria-pressed') === 'true' &&
                isEnabled(control)
            )
          : null;
      },
      '',
      signal,
      1_200
    ).catch(() => null);
    if (!selected) continue;
    const action = await waitFor(
      () =>
        findNamedControl(document, 'Collect payment') ?? findNamedControl(document, 'Close order'),
      '',
      signal,
      1_200
    ).catch(() => null);
    if (!action || accessibleName(action) !== 'collect payment') continue;
    action.click();
    return waitForTarget(document, step, signal);
  }

  throw new TourPreparationError(
    'No seeded open order exposed Collect payment. Reset this demo seat, then retry.'
  );
}

async function prepareDailyClose(document: Document, step: DemoTourStep, signal?: AbortSignal) {
  const existing = targetFor(document, step);
  if (existing) return existing;
  await selectFirstEnabledBranch(
    document,
    'No enabled branch is available for daily close. Confirm this demo seat is ready, then retry.',
    signal
  );
  const tab = await waitFor(
    () => findNamedControl(document, 'Daily close'),
    'Daily close tab is unavailable. Reload this workspace, then retry.',
    signal
  );
  tab.click();
  return waitForTarget(document, step, signal);
}

function tableHeaders(table: HTMLTableElement) {
  return Array.from(table.querySelectorAll('thead th')).map((cell) =>
    normalizedText(cell.textContent)
  );
}

function hasHeaders(table: HTMLTableElement, expected: readonly string[]) {
  const actual = tableHeaders(table);
  return expected.every((heading, index) => actual[index] === heading);
}

function conversionTable(card: HTMLElement) {
  return (
    Array.from(card.querySelectorAll('table'))
      .filter(isVisibleDemoElement)
      .find((table) => {
        if (!hasHeaders(table, ['from', 'to', 'factor'])) return false;
        return Array.from(table.tBodies).some((body) =>
          Array.from(body.rows).some((row) => {
            const from = normalizedText(row.cells[0]?.textContent);
            const to = normalizedText(row.cells[1]?.textContent);
            const factor = normalizedText(row.cells[2]?.textContent);
            return (
              /^(?:g|gm|gram|grams)$/.test(from) &&
              /^(?:kg|kilogram|kilograms)$/.test(to) &&
              /^0\.001(?:0+)?$/.test(factor)
            );
          })
        );
      }) ?? null
  );
}

function numberedCard(document: Document, pattern: RegExp) {
  const heading = Array.from(document.querySelectorAll(HEADING_SELECTOR)).find(
    (element) => isVisibleDemoElement(element) && pattern.test(normalizedText(element.textContent))
  );
  return heading?.closest<HTMLElement>('[data-slot="section-card"]') ?? null;
}

function conversionCard(document: Document) {
  const marked = document.querySelector('[data-tour="recipe-unit-conversion"]');
  if (isUsableTourTarget(marked)) return marked;
  const fallback = numberedCard(document, /^\d+\s+conversions?$/);
  return isUsableTourTarget(fallback) ? fallback : null;
}

function recipeLineTables(scope: ParentNode) {
  const matches: Array<{ card: HTMLElement; table: HTMLTableElement }> = [];
  const labels = Array.from(scope.querySelectorAll('p')).filter(
    (element) =>
      isVisibleDemoElement(element) && normalizedText(element.textContent) === 'recipe lines'
  );
  for (const label of labels) {
    const card = label.closest<HTMLElement>('[data-slot="section-card"]');
    if (!card) continue;
    let container: HTMLElement | null = label.parentElement;
    while (container && card.contains(container)) {
      const table = Array.from(container.querySelectorAll('table'))
        .filter(isVisibleDemoElement)
        .find((candidate) => hasHeaders(candidate, ['source', 'quantity', 'unit', 'order']));
      if (table) {
        matches.push({ card, table });
        break;
      }
      if (container === card) break;
      container = container.parentElement;
    }
  }
  return matches;
}

function hasMixedRecipeUnits(table: HTMLTableElement) {
  const units = Array.from(table.tBodies)
    .flatMap((body) => Array.from(body.rows))
    .map((row) => row.cells[2]?.textContent ?? '')
    .join(' ');
  return hasGramMillilitrePieceLines(units);
}

function validRecipeCard(document: Document) {
  return recipeLineTables(document).find(({ table }) => hasMixedRecipeUnits(table))?.card ?? null;
}

function recipeChoices(document: Document) {
  const list = numberedCard(document, /^\d+\s+recipes?$/);
  if (!list) return [];
  return controls(list).filter((control) => accessibleName(control) === 'manage versions');
}

async function prepareRecipe(document: Document, step: DemoTourStep, signal?: AbortSignal) {
  const units = await waitFor(
    () =>
      controls(document).find((element) => /^units \(\d+\)$/.test(accessibleName(element))) ?? null,
    'Units tab is unavailable in Catalog. Open Catalog, then retry.',
    signal
  );
  units.click();
  const conversion = await waitFor(
    () => conversionCard(document),
    'Unit conversion content is missing. Reset this demo seat, then retry.',
    signal
  );
  if (!conversionTable(conversion)) {
    throw new TourPreparationError(
      'Catalog must visibly prove gram to kilogram factor 0.001 before this tour can continue.'
    );
  }

  const recipes = await waitFor(
    () =>
      controls(document).find((element) => /^recipes \(\d+\)$/.test(accessibleName(element))) ??
      null,
    'Recipes tab is unavailable in Catalog. Reload this workspace, then retry.',
    signal
  );
  recipes.click();

  const choices = await waitFor(
    () => {
      const values = recipeChoices(document);
      return values.length ? values : null;
    },
    'No seeded recipes expose Manage versions. Reset this demo seat, then retry.',
    signal
  );
  let card: HTMLElement | null = null;
  for (const choice of choices) {
    choice.click();
    card = await waitFor(() => validRecipeCard(document), '', signal, 900).catch(() => null);
    if (card) break;
  }
  if (!card) {
    throw new TourPreparationError(
      'No selected seeded recipe visibly contains gram, millilitre, and piece lines. Reset this demo seat, then retry.'
    );
  }

  const previous = card.getAttribute('data-tour');
  if (previous !== step.target) card.setAttribute('data-tour', step.target);
  return {
    target: card,
    cleanup() {
      if (previous == null) card.removeAttribute('data-tour');
      else card.setAttribute('data-tour', previous);
    },
  };
}

export type PreparedTourTarget = { target: HTMLElement; cleanup: () => void };

export async function prepareTourTarget(
  step: DemoTourStep,
  options: { document?: Document; signal?: AbortSignal } = {}
): Promise<PreparedTourTarget> {
  const document = options.document ?? window.document;
  const cleanup = () => {};

  if (step.preparation === 'pos-modifiers') {
    return { target: await preparePos(document, step, options.signal), cleanup };
  }
  if (step.preparation === 'floor-table') {
    return { target: await prepareFloorTable(document, step, options.signal), cleanup };
  }
  if (step.preparation === 'bill-settlement') {
    return { target: await prepareBill(document, step, options.signal), cleanup };
  }
  if (step.preparation === 'daily-close') {
    return { target: await prepareDailyClose(document, step, options.signal), cleanup };
  }
  if (step.preparation === 'recipe-lines') {
    const prepared = await prepareRecipe(document, step, options.signal);
    return 'target' in prepared ? prepared : { target: prepared, cleanup };
  }
  return { target: await waitForTarget(document, step, options.signal), cleanup };
}
