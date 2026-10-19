// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearTourProgress,
  DEMO_TOUR_STORAGE_KEY,
  hasGramMillilitrePieceLines,
  hasGramToKilogramConversion,
  isTourStepPath,
  parseTourProgress,
  readTourProgress,
  saveTourProgress,
  TOUR_STEPS,
  tourStepsForPersona,
} from './tour';
import { isUsableTourTarget, prepareTourTarget } from './tour-preparation';
import { DEMO_SALES_SCRIPT } from './sales-script';

describe('restaurant demo tour', () => {
  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  it('maps all ten required routes, targets, and preparations', () => {
    expect(
      TOUR_STEPS.map(({ id, href, target, preparation }) => ({
        id,
        href,
        target,
        preparation,
      }))
    ).toEqual([
      {
        id: 'dashboard',
        href: '/dashboard',
        target: 'dashboard-overview',
        preparation: undefined,
      },
      {
        id: 'pos-modifiers',
        href: '/pos',
        target: 'pos-order',
        preparation: 'pos-modifiers',
      },
      {
        id: 'kds-ticket',
        href: '/kds',
        target: 'kds-ticket',
        preparation: undefined,
      },
      {
        id: 'floor-table',
        href: '/restaurant/floor',
        target: 'floor-table',
        preparation: 'floor-table',
      },
      {
        id: 'bill-settlement',
        href: '/pos',
        target: 'bill-settlement',
        preparation: 'bill-settlement',
      },
      {
        id: 'daily-close',
        href: '/restaurant/money',
        target: 'daily-close',
        preparation: 'daily-close',
      },
      {
        id: 'inventory-low-stock',
        href: '/restaurant/inventory',
        target: 'inventory-low-stock',
        preparation: undefined,
      },
      {
        id: 'recipe-lines',
        href: '/restaurant/catalog',
        target: 'recipe-lines',
        preparation: 'recipe-lines',
      },
      {
        id: 'purchase-receipt',
        href: '/restaurant/purchasing',
        target: 'purchase-receipt',
        preparation: undefined,
      },
      {
        id: 'reports-overview',
        href: '/restaurant/reports',
        target: 'reports-overview',
        preparation: undefined,
      },
    ]);
  });

  it('keeps one complete sales-script stop behind every tour step', () => {
    expect(DEMO_SALES_SCRIPT).toHaveLength(10);
    expect(new Set(DEMO_SALES_SCRIPT.map(({ id }) => id)).size).toBe(10);
    expect(TOUR_STEPS.map(({ id }) => id)).toEqual(DEMO_SALES_SCRIPT.map(({ id }) => id));
    for (const step of DEMO_SALES_SCRIPT) {
      expect(step.talkingPoints.length).toBeGreaterThanOrEqual(2);
      expect(step.talkingPoints.length).toBeLessThanOrEqual(3);
      expect(step.likelyQuestion.trim()).not.toBe('');
      expect(step.answer.trim()).not.toBe('');
    }
  });

  it('keeps manager intact and limits other personas to applicable routes and preparations', () => {
    expect(tourStepsForPersona('manager')).toBe(TOUR_STEPS);
    expect(tourStepsForPersona('owner').map((step) => step.href)).toEqual([
      '/dashboard',
      '/restaurant/reports',
    ]);
    expect(tourStepsForPersona('cashier').map((step) => [step.href, step.preparation])).toEqual([
      ['/pos', 'bill-settlement'],
    ]);
    expect(tourStepsForPersona('waiter').map((step) => [step.href, step.preparation])).toEqual([
      ['/pos', undefined],
    ]);
    expect(tourStepsForPersona('kitchen').map((step) => [step.href, step.preparation])).toEqual([
      ['/kds', undefined],
    ]);
    expect(tourStepsForPersona('inventory').map((step) => [step.href, step.preparation])).toEqual([
      ['/restaurant/inventory', undefined],
      ['/restaurant/purchasing', undefined],
    ]);
    expect(tourStepsForPersona('finance').map((step) => [step.href, step.preparation])).toEqual([
      ['/restaurant/money', 'daily-close'],
      ['/restaurant/reports', undefined],
    ]);
  });

  it('isolates tour progress by seat and account and validates against the active journey length', () => {
    saveTourProgress(sessionStorage, 7, 'seat1:manager');
    expect(readTourProgress(sessionStorage, 'seat1:kitchen', 1)).toBeNull();
    expect(readTourProgress(sessionStorage, 'seat2:manager')).toBeNull();
    expect(readTourProgress(sessionStorage, 'seat1:manager', 1)).toBeNull();
    saveTourProgress(sessionStorage, 0, 'seat1:kitchen', 1);
    expect(readTourProgress(sessionStorage, 'seat1:kitchen', 1)).toEqual({ index: 0 });
    clearTourProgress(sessionStorage, 'seat1:kitchen');
    expect(readTourProgress(sessionStorage, 'seat1:manager')).toEqual({ index: 7 });
  });

  it('rejects malformed progress and tolerates unavailable storage', () => {
    expect(parseTourProgress('{"version":1,"active":true,"index":9}')).toEqual({ index: 9 });
    expect(parseTourProgress('{"version":1,"active":true,"index":10}')).toBeNull();
    expect(parseTourProgress('{bad json')).toBeNull();
    expect(
      readTourProgress({
        getItem: () => {
          throw new Error('denied');
        },
      })
    ).toBeNull();

    saveTourProgress(sessionStorage, 3);
    expect(JSON.parse(sessionStorage.getItem(DEMO_TOUR_STORAGE_KEY) ?? '')).toEqual({
      version: 1,
      active: true,
      index: 3,
    });
    clearTourProgress(sessionStorage);
    expect(sessionStorage.getItem(DEMO_TOUR_STORAGE_KEY)).toBeNull();
  });

  it('normalizes route slashes and requires visible, non-empty targets', () => {
    expect(isTourStepPath(TOUR_STEPS[7], '/restaurant/catalog/')).toBe(true);
    const empty = document.createElement('section');
    const hidden = document.createElement('section');
    hidden.hidden = true;
    hidden.textContent = 'Seeded row';
    const ready = document.createElement('section');
    ready.textContent = 'Seeded row';
    document.body.append(empty, hidden, ready);
    expect(isUsableTourTarget(empty)).toBe(false);
    expect(isUsableTourTarget(hidden)).toBe(false);
    expect(isUsableTourTarget(ready)).toBe(true);
  });

  it('waits for an async true POS marker and ignores false-valued markers', async () => {
    document.body.innerHTML = `
      <section data-tour="pos-order">
        <h2>Effective menu</h2>
        ${Array.from(
          { length: 12 },
          (_, index) =>
            `<button type="button" aria-pressed="false" data-demo-modifier-item="false" data-plain-item="${index}">Plain item ${index}</button>`
        ).join('')}
      </section>
    `;
    const surface = document.querySelector<HTMLElement>('[data-tour="pos-order"]')!;
    const selected: string[] = [];
    surface.querySelectorAll<HTMLElement>('[data-plain-item]').forEach((item) => {
      item.addEventListener('click', () => selected.push(item.textContent?.trim() ?? ''));
    });
    const preparation = prepareTourTarget(TOUR_STEPS[1], { document });
    const selectedTrueItem = new Promise<void>((resolve) => {
      window.setTimeout(() => {
        surface.insertAdjacentHTML(
          'beforeend',
          '<button id="late-modifier-item" type="button" aria-pressed="false" data-demo-modifier-item="true">Late modifier item</button>'
        );
        document.querySelector('#late-modifier-item')!.addEventListener('click', () => {
          selected.push('Late modifier item');
          resolve();
          window.setTimeout(() => {
            surface.insertAdjacentHTML(
              'beforeend',
              '<fieldset data-demo-modifier-group="true"><legend>Size</legend></fieldset>'
            );
          }, 25);
        });
      }, 25);
    });
    await selectedTrueItem;
    expect(selected).toEqual(['Late modifier item']);
    expect(surface.querySelector('[data-demo-modifier-group]')).toBeNull();

    const prepared = await preparation;
    expect(prepared.target).toBe(surface);
    expect(prepared.target.querySelector('[data-demo-modifier-group]')).not.toBeNull();
  });

  it('selects an async branch option and waits for the real floor table target', async () => {
    document.body.innerHTML = `
      <select aria-label="Branch">
        <option value="" selected disabled>Select a branch</option>
      </select>
    `;
    const branch = document.querySelector<HTMLSelectElement>('select[aria-label="Branch"]')!;
    const changes: string[] = [];
    branch.addEventListener('change', () => {
      changes.push(branch.value);
      window.setTimeout(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<section data-tour="floor-table">Table A1</section>'
        );
      }, 25);
    });

    const preparation = prepareTourTarget(TOUR_STEPS[3], { document });
    window.setTimeout(() => {
      branch.insertAdjacentHTML('beforeend', '<option value="branch-1">Main branch</option>');
    }, 25);

    const prepared = await preparation;
    expect(changes).toEqual(['branch-1']);
    expect(branch.value).toBe('branch-1');
    expect(prepared.target).toBe(document.querySelector('[data-tour="floor-table"]'));
  });

  it('selects the first enabled nonempty branch before opening Daily close', async () => {
    document.body.innerHTML = `
      <select aria-label="Branch" disabled>
        <option value="ignored">Ignored branch</option>
      </select>
      <select aria-label="Branch">
        <option value="" selected disabled>Select a branch</option>
        <option value="disabled" disabled>Disabled branch</option>
        <option value="branch-1">Main branch</option>
        <option value="branch-2">Second branch</option>
      </select>
      <button type="button" role="tab">Daily close</button>
    `;
    const branch = document.querySelectorAll<HTMLSelectElement>('select')[1]!;
    const tab = document.querySelector<HTMLButtonElement>('[role="tab"]')!;
    const events: string[] = [];
    branch.addEventListener('change', (event) => {
      events.push(`change:${branch.value}:${event.bubbles}`);
    });
    tab.addEventListener('click', () => {
      events.push(`tab:${branch.value}`);
      document.body.insertAdjacentHTML(
        'beforeend',
        '<section data-tour="daily-close">Daily close summary</section>'
      );
    });

    const prepared = await prepareTourTarget(TOUR_STEPS[5], { document });

    expect(branch.value).toBe('branch-1');
    expect(events).toEqual(['change:branch-1:true', 'tab:branch-1']);
    expect(prepared.target).toBe(document.querySelector('[data-tour="daily-close"]'));
  });

  it('selects real open-order buttons until Collect payment appears without closing an order', async () => {
    document.body.innerHTML = `
      <div data-slot="section-card">
        <h3>Open orders</h3>
        <button type="button">Refresh</button>
        <button id="open-order" type="button" aria-pressed="false"><span>#101 · 2 items</span><span>4,200.00</span></button>
        <button id="pending-order" type="button" aria-pressed="false"><span>#102 · 1 item</span><span>2,100.00</span></button>
      </div>
      <div id="order-detail"></div>
      <div id="checkout"></div>
    `;
    const detail = document.querySelector('#order-detail')!;
    let closeClicks = 0;
    document.querySelector('#open-order')!.addEventListener('click', () => {
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('[data-slot="section-card"]')!.outerHTML = `
          <div data-slot="section-card">
            <h3>Open orders</h3>
            <button id="open-order" type="button" aria-pressed="true"><span>#101 · 2 items</span><span>4,200.00</span></button>
            <button id="pending-order" type="button" aria-pressed="false"><span>#102 · 1 item</span><span>2,100.00</span></button>
          </div>
        `;
        detail.innerHTML = '<button id="close-order" type="button">Close order</button>';
        detail.querySelector('#close-order')!.addEventListener('click', () => closeClicks++);
      }, 25);
    });
    document.querySelector('#pending-order')!.addEventListener('click', () => {
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('[data-slot="section-card"]')!.outerHTML = `
          <div data-slot="section-card">
            <h3>Open orders</h3>
            <button id="open-order" type="button" aria-pressed="false"><span>#101 · 2 items</span><span>4,200.00</span></button>
            <button id="pending-order" type="button" aria-pressed="true"><span>#102 · 1 item</span><span>2,100.00</span></button>
          </div>
        `;
        detail.innerHTML = '<button id="collect-payment" type="button">Collect payment</button>';
        detail.querySelector('#collect-payment')!.addEventListener('click', () => {
          document.querySelector('#checkout')!.innerHTML =
            '<div data-tour="bill-settlement">Split tender and refund controls</div>';
        });
      }, 25);
    });

    const prepared = await prepareTourTarget(TOUR_STEPS[4], { document });
    expect(prepared.target).toBe(document.querySelector('[data-tour="bill-settlement"]'));
    expect(closeClicks).toBe(0);
  });

  it('proves recipe units before dynamically decorating and cleaning the real card', async () => {
    document.body.innerHTML = `
      <button role="tab">Units (3)</button>
      <div data-slot="section-card" data-tour="recipe-unit-conversion">
        <h3>1 conversion</h3>
        <table><thead><tr><th>From</th><th>To</th><th>Factor</th><th>Actions</th></tr></thead>
          <tbody><tr><td>Gram</td><td>Kilogram</td><td>0.001</td><td></td></tr></tbody></table>
      </div>
      <button role="tab">Recipes (2)</button>
      <div data-slot="section-card"><h3>2 recipes</h3><table><tbody>
        <tr><td>Simple chai</td><td><button id="simple" type="button">Manage versions</button></td></tr>
        <tr><td>Mixed platter</td><td><button id="mixed" type="button">Manage versions</button></td></tr>
      </tbody></table></div>
      <div data-slot="section-card" id="simple-detail" hidden><h3>Simple chai</h3><div>
        <div><p>Recipe lines</p></div>
        <table><thead><tr><th>Source</th><th>Quantity</th><th>Unit</th><th>Order</th></tr></thead>
          <tbody><tr><td>Tea</td><td>250</td><td>Gram</td><td>1</td></tr></tbody></table>
      </div></div>
      <div data-slot="section-card" id="mixed-detail" hidden><h3>Mixed platter</h3><div>
        <div><p>Recipe lines</p></div>
        <table><thead><tr><th>Source</th><th>Quantity</th><th>Unit</th><th>Order</th></tr></thead><tbody>
          <tr><td>Spice</td><td>250</td><td>Gram</td><td>1</td></tr>
          <tr><td>Stock</td><td>30</td><td>Millilitre</td><td>2</td></tr>
          <tr><td>Bun</td><td>2</td><td>Piece</td><td>3</td></tr>
        </tbody></table>
      </div></div>
    `;
    let choices = 0;
    document.querySelector('#simple')!.addEventListener('click', () => {
      choices++;
      (document.querySelector('#simple-detail') as HTMLElement).hidden = false;
    });
    document.querySelector('#mixed')!.addEventListener('click', () => {
      choices++;
      (document.querySelector('#mixed-detail') as HTMLElement).hidden = false;
    });

    const prepared = await prepareTourTarget(TOUR_STEPS[7], { document });
    expect(prepared.target).toBe(document.querySelector('#mixed-detail'));
    expect(choices).toBe(2);
    expect(prepared.target).toHaveAttribute('data-tour', 'recipe-lines');
    prepared.cleanup();
    expect(prepared.target).not.toHaveAttribute('data-tour');
  });

  it('blocks recipe narration when conversion proof is wrong', async () => {
    document.body.innerHTML = `
      <button role="tab">Units (1)</button>
      <div data-slot="section-card" data-tour="recipe-unit-conversion"><h3>1 conversion</h3>
        <table><thead><tr><th>From</th><th>To</th><th>Factor</th><th>Actions</th></tr></thead>
          <tbody><tr><td>Gram</td><td>Kilogram</td><td>1</td><td></td></tr></tbody></table>
      </div>
      <button role="tab">Recipes (0)</button>
    `;

    await expect(prepareTourTarget(TOUR_STEPS[7], { document })).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining('factor 0.001'),
      })
    );
    expect(hasGramToKilogramConversion('1 gram = 0.001 kilogram')).toBe(true);
    expect(hasGramMillilitrePieceLines('250 g, 30 ml, 2 pieces')).toBe(true);
  });
});
