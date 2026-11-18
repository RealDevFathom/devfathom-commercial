import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as zod from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Source-only boundary proof: execute the real menu domain with inert collaborators.
// No provider, fixture payload, database, storage implementation, or application env is loaded.
function setup(node = 'test', selected = 'FIXTURE') {
  const events = [];
  const env = { NODE_ENV: node, MENU_IMPORT_ADAPTER: selected };
  const result = {
    adapter: 'FIXTURE',
    adapterVersion: 'synthetic-v1',
    pages: [
      {
        pageNumber: 1,
        warnings: [],
        lines: [
          {
            sortOrder: 1,
            categoryName: null,
            productName: 'Synthetic item',
            description: null,
            ingredients: [],
            price: { amount: null, currency: null, raw: null },
            variants: [],
            modifiers: [],
            confidence: {},
            flags: ['MISSING_PRICE'],
          },
        ],
      },
    ],
  };
  const fixture = {
    extract: async () => {
      events.push('fixture-extract');
      return result;
    },
  };
  const vision = {
    extract: async () => {
      events.push('vision-extract');
      return result;
    },
  };
  const effect =
    (name, value) =>
    async (...args) => {
      events.push([name, ...args]);
      return value;
    };
  class Decimal {
    constructor(value) {
      this.value = value;
    }
    toString() {
      return this.value;
    }
    // Mirrors Prisma.Decimal.equals: numeric (not string) equality, so '1.50' equals '1.5'.
    equals(other) {
      const normalize = (v) => {
        const [int, frac = ''] = String(v instanceof Decimal ? v.value : v)
          .trim()
          .replace(/^\+/, '')
          .split('.');
        const neg = int.startsWith('-');
        const digits = (neg ? int.slice(1) : int).replace(/^0+(?=\d)/, '');
        const fraction = frac.replace(/0+$/, '');
        const zero = /^0*$/.test(digits) && fraction === '';
        return `${neg && !zero ? '-' : ''}${digits || '0'}${fraction ? `.${fraction}` : ''}`;
      };
      return normalize(this) === normalize(other);
    }
  }
  const boundaries = {
    'server-only': {},
    zod,
    '@/generated/prisma/client': { Prisma: { Decimal } },
    '@/lib/restaurant/catalog': {
      createProduct: effect('createProduct', { id: 'product_1' }),
      createCategory: effect('createCategory', { id: 'category_1' }),
      createVariant: effect('createVariant', { id: 'variant_1' }),
      ensureDefaultBrand: effect('ensureDefaultBrand', { id: 'brand_1' }),
    },
    '@/lib/restaurant/menus': {
      createMenu: effect('createMenu', { id: 'menu_1' }),
      createMenuItem: effect('createMenuItem', { id: 'item_1' }),
      createMenuSection: effect('createMenuSection', { id: 'section_1' }),
    },
    '@/lib/restaurant/price-lists': {
      addPriceListEntry: effect('addPriceListEntry', { id: 'entry_1' }),
      createPriceListVersion: effect('createPriceListVersion', { id: 'version_1' }),
    },
    '@/lib/restaurant/scheduler': { enqueue: effect('enqueue', { job: { id: 'job_1' } }) },
    '@/lib/storage': {
      assertStorageAvailable() {},
      getStorageAvailability: () => ({ available: true }),
      putUpload: effect('put'),
      getUpload: effect('read', Buffer.from('inert')),
      deleteUpload: effect('delete'),
    },
    '@/lib/ai/provider': { readAIAvailability: () => ({ available: selected === 'VISION' }) },
    '@/lib/tenancy/demo-isolation': { isDemoTenant: async () => node === 'demo' },
    '@/lib/restaurant/menu-extraction-vision': {
      createVisionMenuExtractionAdapter: () => {
        events.push('vision-factory');
        return vision;
      },
    },
    '@/lib/restaurant/menu-extraction-fixtures': {
      createFixtureMenuExtractionAdapter: () => {
        events.push('fixture-factory');
        return fixture;
      },
    },
  };
  const cache = {};
  function load(specifier) {
    // Sibling imports (`./menu-extraction-fixtures`) name the same module as their alias.
    const name = specifier.startsWith('./') ? `@/lib/restaurant/${specifier.slice(2)}` : specifier;
    if (boundaries[name]) return boundaries[name];
    if (cache[name]) return cache[name];
    assert.match(
      name,
      /^@\/lib\/restaurant\/menu-(import(?:-legacy|-fixture-runtime|-uploads)?|extraction)$/
    );
    const file = path.join(__dirname, name.split('/').at(-1) + '.ts');
    const source = fs.readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    assert.equal(compiled.diagnostics.length, 0);
    const moduleState = { exports: {} };
    const localRequire = (n) => (n === 'node:crypto' ? crypto : load(n));
    vm.runInNewContext(
      compiled.outputText,
      {
        require: localRequire,
        module: moduleState,
        exports: moduleState.exports,
        Buffer,
        process: { env },
        Date,
        console,
      },
      { filename: file }
    );
    return (cache[name] = moduleState.exports);
  }
  const record = {
    id: 'imp_1',
    organizationId: 'org_1',
    status: 'PENDING_EXTRACTION',
    adapter: 'FIXTURE',
    storageObjectName: 'source.png',
    mimeType: 'image/png',
    pageCount: 1,
    defaultCurrency: null,
  };
  const lines = [];
  const db = {
    restaurantMenuImport: {
      findUnique: async () => record,
      findFirst: async () => null,
      update: async ({ data }) => {
        events.push(['status', data.status]);
        Object.assign(record, data);
        return record;
      },
      create: effect('row-create', record),
    },
    restaurantMenuImportPage: {
      deleteMany: effect('page-delete'),
      create: effect('page-create', { id: 'page_1' }),
    },
    restaurantMenuImportLine: {
      create: async ({ data }) => {
        lines.push(data);
      },
      findMany: async () => lines,
      findUnique: async () => ({
        id: 'line_1',
        extractedProductName: 'Synthetic item',
        extractedPriceAmount: null,
        import: record,
      }),
      update: async ({ data }) => {
        events.push(['review', data]);
        return data;
      },
    },
    restaurantProduct: { findMany: async () => [] },
    restaurantCategory: { findMany: async () => [] },
    restaurantPriceList: {
      findFirst: async () => ({ id: 'price_list_1' }),
      create: effect('price-list-create', { id: 'price_list_1' }),
    },
    organization: {
      findUnique: async () => ({ currency: record.currentCurrency ?? record.defaultCurrency }),
    },
    $queryRaw: async (strings, ...values) => {
      const query = strings.join('?');
      if (query.includes('FROM "organizations"')) {
        assert.match(query, /FROM "organizations"[\s\S]+FOR SHARE/);
        assert.doesNotMatch(query, /FOR UPDATE/);
        events.push(['organization-currency-lock', ...values]);
        return [{ currency: record.currentCurrency ?? record.defaultCurrency }];
      }
      events.push(['row-lock', ...values]);
      return [];
    },
    $transaction: async (fn) => {
      events.push('transaction');
      return fn(db);
    },
  };
  return { load, events, db, record, lines, result, env };
}

for (const node of ['test', 'development']) {
  test(`legacy ${node} composition preserves extraction output and review-only persistence`, async () => {
    const f = setup(node);
    const menu = f.load('@/lib/restaurant/menu-import-legacy');
    const outcome = await menu.runMenuImportExtraction(f.db, 'imp_1');
    assert.equal(outcome.status, 'AWAITING_REVIEW');
    assert.equal(outcome.lineCount, 1);
    assert.equal(f.lines[0].extractedProductName, 'Synthetic item');
    assert.equal(f.lines[0].extractedPriceAmount, null);
    assert.equal(f.record.adapterVersion, 'synthetic-v1');
    assert.ok(f.events.includes('fixture-extract'));
    assert.ok(f.events.includes('transaction'));
    assert.ok(
      !f.events.some(
        (e) =>
          Array.isArray(e) && ['createProduct', 'createMenu', 'addPriceListEntry'].includes(e[0])
      )
    );
  });
}
for (const node of ['production', undefined]) {
  test(`FIXTURE refusal in ${node} retains EXTRACTING and failure evidence without effects`, async () => {
    const f = setup(node);
    if (node === undefined) delete f.env.NODE_ENV;
    const menu = f.load('@/lib/restaurant/menu-import-legacy');
    const out = await menu.runMenuImportExtraction(f.db, 'imp_1');
    assert.equal(out.status, 'EXTRACTION_FAILED');
    assert.equal(
      JSON.stringify(f.events),
      JSON.stringify([
        ['status', 'EXTRACTING'],
        ['status', 'EXTRACTION_FAILED'],
      ])
    );
    assert.equal(f.record.failureReason, 'Menu extraction is unavailable.');
    assert.ok(f.record.extractionStartedAt instanceof Date);
    assert.ok(f.record.extractionCompletedAt instanceof Date);
    assert.equal(f.record.storageObjectName, 'source.png');
    assert.equal((await menu.runMenuImportExtraction(f.db, 'imp_1')).status, 'SKIPPED');
    assert.throws(
      () =>
        f
          .load('@/lib/restaurant/menu-import-fixture-runtime')
          .fixtureMenuImportRuntime.resolveAdapter('FIXTURE'),
      { reason: 'ADAPTER_UNAVAILABLE' }
    );
  });
}
for (const selected of [undefined, '', 'disabled', 'typo']) {
  test(`unavailable upload ${String(selected)} has zero effects`, async () => {
    const f = setup();
    f.env.MENU_IMPORT_ADAPTER = selected;
    const menu = f.load('@/lib/restaurant/menu-import');
    await assert.rejects(
      menu.createMenuImport(f.db, 'org_1', {
        fileName: 'synthetic.png',
        content: Buffer.from('inert'),
        createdById: 'user_1',
      }),
      { reason: 'ADAPTER_UNAVAILABLE' }
    );
    assert.equal(f.events.length, 0);
  });
}
test('production core refuses the fixture and missing injection fails before storage', async () => {
  // The core resolves FIXTURE only for an explicitly configured test/dev sandbox
  // (the HTTP and worker path the e2e database runs); production never does.
  const sandbox = setup('test');
  const sandboxMenu = sandbox.load('@/lib/restaurant/menu-import');
  assert.equal(
    await sandboxMenu.defaultMenuImportRuntime.resolveAdapter('FIXTURE').extract(),
    sandbox.result
  );
  assert.deepEqual(sandbox.events, ['fixture-factory', 'fixture-extract']);

  const f = setup('production');
  const menu = f.load('@/lib/restaurant/menu-import');
  assert.throws(() => menu.defaultMenuImportRuntime.resolveAdapter('FIXTURE'), {
    reason: 'ADAPTER_UNAVAILABLE',
  });
  assert.equal((await menu.runMenuImportExtraction(f.db, 'imp_1')).status, 'EXTRACTION_FAILED');
  assert.equal(
    JSON.stringify(f.events),
    JSON.stringify([
      ['status', 'EXTRACTING'],
      ['status', 'EXTRACTION_FAILED'],
    ])
  );
  assert.ok(!f.events.includes('fixture-factory'));
});
test('legacy composition retains VISION resolver and explicit runtime override', async () => {
  const f = setup('test', 'VISION');
  f.record.adapter = 'VISION';
  const menu = f.load('@/lib/restaurant/menu-import-legacy');
  await menu.runMenuImportExtraction(f.db, 'imp_1');
  assert.ok(f.events.includes('vision-extract'));
  assert.ok(!f.events.includes('fixture-factory'));
  f.record.status = 'PENDING_EXTRACTION';
  let injected = 0;
  await menu.runMenuImportExtraction(f.db, 'imp_1', {
    runtime: {
      readSource: async () => Buffer.from('inert'),
      resolveAdapter: () => ({
        extract: async () => {
          injected++;
          return f.result;
        },
      }),
    },
  });
  assert.equal(injected, 1);
});
test('legacy job retains demo denial before storage, provider or catalog', async () => {
  const f = setup('demo');
  await f
    .load('@/lib/restaurant/menu-import-legacy')
    .menuImportExtractHandler({ db: f.db, job: { payload: { importId: 'imp_1' } } });
  assert.equal(f.events.length, 0);
});
test('manual review remains persistent while extraction disabled and commit still locks and requires review', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  const reviewed = await menu.reviewMenuImportLine(f.db, {
    lineId: 'line_1',
    decision: 'ACCEPTED',
    reviewedById: 'user_1',
    priceAmount: '12.50',
  });
  assert.equal(reviewed.reviewStatus, 'ACCEPTED');
  assert.equal(reviewed.reviewedPriceAmount.toString(), '12.50');
  assert.ok(f.events.some((e) => Array.isArray(e) && e[0] === 'review'));
  f.lines.push({ reviewStatus: 'PENDING' });
  await assert.rejects(
    menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' }),
    { reason: 'REVIEW_INCOMPLETE' }
  );
  assert.ok(f.events.includes('transaction'));
  assert.ok(f.events.some((e) => Array.isArray(e) && e[0] === 'row-lock'));
  assert.ok(
    f.events.some(
      (e) => Array.isArray(e) && e[0] === 'organization-currency-lock' && e[1] === 'org_1'
    )
  );
  assert.ok(
    !f.events.some(
      (e) => Array.isArray(e) && ['createProduct', 'createMenu', 'addPriceListEntry'].includes(e[0])
    )
  );
});

test('commit rejects a reviewed foreign-currency amount without an explicit local conversion', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'foreign-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.lines.push({
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: null,
    extractedProductName: 'Foreign item',
    extractedDescription: null,
    extractedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('12.50'),
    extractedCurrency: 'USD',
    extractedVariants: [],
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    mergeProductId: null,
    mergeVariantId: null,
  });

  await assert.rejects(
    menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' }),
    { reason: 'CURRENCY_MISMATCH' }
  );
  assert.ok(
    !f.events.some(
      (event) =>
        Array.isArray(event) &&
        ['createProduct', 'createMenu', 'addPriceListEntry'].includes(event[0])
    )
  );
});

test('commit accepts an explicitly reviewed local conversion when extracted currency is unknown', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'unknown-currency-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.lines.push({
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: null,
    extractedProductName: 'Reviewed conversion',
    extractedDescription: null,
    extractedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('12.50'),
    extractedCurrency: null,
    extractedVariants: [],
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('3500'),
    reviewedCurrency: 'pkr',
    mergeProductId: null,
    mergeVariantId: null,
  });

  await menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' });
  assert.ok(
    f.events.some(
      (event) =>
        Array.isArray(event) &&
        event[0] === 'addPriceListEntry' &&
        event[2]?.price.toString() === '3500'
    )
  );
});

test('commit accepts priced variants in the current organization currency', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'local-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.lines.push({
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: null,
    extractedProductName: 'Local item',
    extractedDescription: null,
    extractedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('500'),
    extractedCurrency: 'PKR',
    extractedVariants: [{ name: 'Large', price: { amount: '650', currency: 'pkr' } }],
    reviewedVariants: confirmedAsPrinted([
      { name: 'Large', price: { amount: '650', currency: 'pkr' } },
    ]),
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    mergeProductId: null,
    mergeVariantId: null,
  });

  await menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' });
  assert.ok(
    f.events.some(
      (event) =>
        Array.isArray(event) && event[0] === 'addPriceListEntry' && event[2]?.price === '650'
    )
  );
});

test('commit rejects a foreign priced variant even when the base price has a reviewed conversion', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'mixed-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.lines.push({
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: null,
    extractedProductName: 'Mixed item',
    extractedDescription: null,
    extractedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('10'),
    extractedCurrency: 'USD',
    extractedVariants: [{ name: 'Large', price: { amount: '15', currency: 'USD' } }],
    reviewedVariants: confirmedAsPrinted([
      { name: 'Large', price: { amount: '15', currency: 'USD' } },
    ]),
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('2800'),
    reviewedCurrency: 'PKR',
    mergeProductId: null,
    mergeVariantId: null,
  });

  await assert.rejects(
    menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' }),
    { reason: 'CURRENCY_MISMATCH' }
  );
  assert.ok(!f.events.some((event) => Array.isArray(event) && event[0] === 'createProduct'));
});

/** Sizes as a reviewer confirms them unchanged: stored in the extracted shape,
 * keeping each printed currency (see normalizeReviewedVariants). Commit imports
 * only reviewer-confirmed sizes, never the raw extraction. */
function confirmedAsPrinted(variants) {
  return variants.map((variant) => ({
    name: variant.name,
    price: {
      amount: variant.price?.amount ?? null,
      currency: variant.price?.currency?.toUpperCase() ?? null,
      raw: null,
    },
  }));
}

function currencylessVariantLine(Decimal, overrides) {
  const line = {
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: null,
    extractedProductName: 'Sized item',
    extractedDescription: null,
    extractedPriceAmount: new Decimal('500'),
    extractedCurrency: 'PKR',
    extractedVariants: [{ name: 'Large', price: { amount: '650' } }],
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    mergeProductId: null,
    mergeVariantId: null,
    ...overrides,
  };
  return { reviewedVariants: confirmedAsPrinted(line.extractedVariants), ...line };
}

for (const [label, overrides] of [
  ['the extracted line currency', {}],
  ['a reviewer-confirmed line currency', { extractedCurrency: null, reviewedCurrency: 'pkr' }],
]) {
  test(`commit imports a currencyless size price in ${label}`, async () => {
    const f = setup('production', 'disabled');
    const menu = f.load('@/lib/restaurant/menu-import');
    const { Decimal } = f.load('@/generated/prisma/client').Prisma;
    f.record.status = 'AWAITING_REVIEW';
    f.record.fileName = 'sized-menu.png';
    f.record.defaultCurrency = 'PKR';
    f.lines.push(currencylessVariantLine(Decimal, overrides));

    await menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' });
    assert.ok(f.events.some((event) => Array.isArray(event) && event[0] === 'createVariant'));
    assert.ok(
      f.events.some(
        (event) =>
          Array.isArray(event) && event[0] === 'addPriceListEntry' && event[2]?.price === '650'
      )
    );
  });
}

test('commit rejects a currencyless size price when the line has no confirmed currency', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  const { Decimal } = f.load('@/generated/prisma/client').Prisma;
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'ambiguous-variant-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.lines.push(currencylessVariantLine(Decimal, { extractedCurrency: null }));

  await assert.rejects(
    menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' }),
    { reason: 'CURRENCY_MISMATCH' }
  );
  assert.ok(!f.events.some((event) => Array.isArray(event) && event[0] === 'createProduct'));
});

test('commit rejects a currencyless size price when only the foreign base price was converted', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  const { Decimal } = f.load('@/generated/prisma/client').Prisma;
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'foreign-sized-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.lines.push(
    currencylessVariantLine(Decimal, {
      extractedPriceAmount: new Decimal('10'),
      extractedCurrency: 'USD',
      extractedVariants: [{ name: 'Large', price: { amount: '15' } }],
      reviewedPriceAmount: new Decimal('2800'),
      reviewedCurrency: 'PKR',
    })
  );

  await assert.rejects(
    menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' }),
    { reason: 'CURRENCY_MISMATCH' }
  );
  assert.ok(!f.events.some((event) => Array.isArray(event) && event[0] === 'createProduct'));
});

for (const variantCurrency of ['USD', null]) {
  test(`commit merges a converted base price without importing ${variantCurrency} extracted variant prices`, async () => {
    const f = setup('production', 'disabled');
    const menu = f.load('@/lib/restaurant/menu-import');
    const { Decimal } = f.load('@/generated/prisma/client').Prisma;
    f.record.status = 'AWAITING_REVIEW';
    f.record.fileName = 'merged-menu.png';
    f.record.defaultCurrency = 'PKR';
    f.lines.push({
      id: 'line_1',
      reviewStatus: 'MERGED',
      sortOrder: 1,
      extractedCategoryName: null,
      extractedProductName: 'Merged item',
      extractedDescription: null,
      extractedPriceAmount: new Decimal('10'),
      extractedCurrency: 'USD',
      extractedVariants: [{ name: 'Large', price: { amount: '15', currency: variantCurrency } }],
      reviewedCategoryName: null,
      reviewedProductName: null,
      reviewedDescription: null,
      reviewedPriceAmount: new Decimal('2800'),
      reviewedCurrency: 'PKR',
      mergeProductId: 'existing_product',
      mergeVariantId: 'existing_variant',
    });

    const outcome = await menu.commitMenuImport(f.db, {
      importId: 'imp_1',
      committedById: 'user_1',
    });
    assert.equal(outcome.mergedProductIds[0], 'existing_product');
    const entries = f.events.filter(
      (event) => Array.isArray(event) && event[0] === 'addPriceListEntry'
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0][2].price.toString(), '2800');
    assert.equal(entries[0][2].productId, 'existing_product');
    assert.equal(entries[0][2].variantId, 'existing_variant');
    assert.ok(
      !f.events.some(
        (event) => Array.isArray(event) && ['createProduct', 'createVariant'].includes(event[0])
      )
    );
  });
}

test('commit validates reviewed prices against the current organization currency', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'stale-currency-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.record.currentCurrency = 'USD';
  f.lines.push({
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: null,
    extractedProductName: 'Stale conversion',
    extractedDescription: null,
    extractedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('10'),
    extractedCurrency: 'USD',
    extractedVariants: [],
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('2800'),
    reviewedCurrency: 'PKR',
    mergeProductId: null,
    mergeVariantId: null,
  });

  await assert.rejects(
    menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' }),
    { reason: 'CURRENCY_MISMATCH' }
  );
  assert.ok(!f.events.some((event) => Array.isArray(event) && event[0] === 'createProduct'));
});

test('commit rejects an extracted price when the organization currency changed after upload', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.record.fileName = 'stale-extraction-menu.png';
  f.record.defaultCurrency = 'PKR';
  f.record.currentCurrency = 'USD';
  f.lines.push({
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: null,
    extractedProductName: 'Stale extracted price',
    extractedDescription: null,
    extractedPriceAmount: new (f.load('@/generated/prisma/client').Prisma.Decimal)('500'),
    extractedCurrency: 'PKR',
    extractedVariants: [],
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    mergeProductId: null,
    mergeVariantId: null,
  });

  await assert.rejects(
    menu.commitMenuImport(f.db, { importId: 'imp_1', committedById: 'user_1' }),
    { reason: 'CURRENCY_MISMATCH' }
  );
  assert.ok(!f.events.some((event) => Array.isArray(event) && event[0] === 'createProduct'));
});

for (const node of ['test', 'development', 'production']) {
  test(`configured FIXTURE upload in ${node} preserves preflight and composition policy`, async () => {
    const f = setup(node);
    const menu = f.load('@/lib/restaurant/menu-import-legacy');
    const runtime = f.load('@/lib/restaurant/menu-import-fixture-runtime').fixtureMenuImportRuntime;
    // Synthetic PNG header; no real menu payload.
    f.record.storageObjectName = null;
    const input = {
      fileName: 'synthetic.png',
      content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0]),
      createdById: 'user_1',
      adapter: 'FIXTURE',
    };
    if (node === 'production') {
      await assert.rejects(menu.createMenuImport(f.db, 'org_1', input, { runtime }), {
        reason: 'ADAPTER_UNAVAILABLE',
      });
      assert.equal(f.events.length, 0);
    } else {
      const outcome = await menu.createMenuImport(f.db, 'org_1', input, { runtime });
      assert.equal(outcome.importId, 'imp_1');
      assert.ok(f.events.some((e) => Array.isArray(e) && e[0] === 'row-create'));
      assert.ok(f.events.some((e) => Array.isArray(e) && e[0] === 'put'));
      assert.ok(f.events.some((e) => Array.isArray(e) && e[0] === 'enqueue'));
    }
  });
}
