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
  }
  const boundaries = {
    'server-only': {},
    zod,
    '@/generated/prisma/client': { Prisma: { Decimal } },
    '@/lib/restaurant/catalog': Object.fromEntries(
      ['createProduct', 'createCategory', 'createVariant', 'ensureDefaultBrand'].map((n) => [
        n,
        effect(n),
      ])
    ),
    '@/lib/restaurant/menus': {
      createMenu: effect('createMenu'),
      createMenuItem: effect('createMenuItem'),
      createMenuSection: effect('createMenuSection'),
    },
    '@/lib/restaurant/price-lists': {
      addPriceListEntry: effect('addPriceListEntry'),
      createPriceListVersion: effect('createPriceListVersion'),
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
  function load(name) {
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
        importId: 'imp_1',
        extractedProductName: 'Synthetic item',
        extractedPriceAmount: null,
        extractedVariants: [],
        import: record,
      }),
      update: async ({ data }) => {
        events.push(['review', data]);
        return data;
      },
    },
    restaurantProduct: { findMany: async () => [] },
    $queryRaw: effect('row-lock', []),
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
test('production core has no fixture import and missing injection fails before storage', async () => {
  const f = setup();
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
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, 'menu-import.ts'), 'utf8'),
    /menu-extraction-fixtures|createFixtureMenuExtractionAdapter/
  );
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
    !f.events.some(
      (e) => Array.isArray(e) && ['createProduct', 'createMenu', 'addPriceListEntry'].includes(e[0])
    )
  );
});
test('accepting extracted variants requires and persists explicit human review', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.db.restaurantMenuImportLine.findUnique = async () => ({
    id: 'line_1',
    importId: 'imp_1',
    extractedProductName: 'Synthetic item',
    extractedPriceAmount: new (class {
      toString() { return '10.00'; }
    })(),
    extractedVariants: [
      { name: 'Large', price: { amount: '14.00' } },
      { name: 'Family', price: { amount: null } },
    ],
    import: f.record,
  });

  await assert.rejects(
    menu.reviewMenuImportLine(f.db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
    }),
    { reason: 'REVIEW_INCOMPLETE' }
  );

  await menu.reviewMenuImportLine(f.db, {
    lineId: 'line_1',
    decision: 'ACCEPTED',
    reviewedById: 'user_1',
    variants: [
      { name: 'Large', priceAmount: '15.00' },
      { name: 'Family', priceAmount: '' },
    ],
  });
  const review = f.events.findLast((event) => Array.isArray(event) && event[0] === 'review');
  assert.equal(
    JSON.stringify(review[1].reviewedVariants),
    JSON.stringify([
      { name: 'Large', price: { amount: '15.00' } },
      { name: 'Family', price: { amount: null } },
    ])
  );
});

test('accepting does not restore an extracted value that the reviewer explicitly cleared', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.db.restaurantMenuImportLine.findUnique = async () => ({
    id: 'line_1',
    importId: 'imp_1',
    extractedProductName: 'Synthetic item',
    extractedPriceAmount: new (class {
      toString() { return '10.00'; }
    })(),
    extractedVariants: [],
    import: f.record,
  });

  await assert.rejects(
    menu.reviewMenuImportLine(f.db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      priceAmount: null,
    }),
    { reason: 'PRICE_REQUIRED' }
  );
  await assert.rejects(
    menu.reviewMenuImportLine(f.db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      productName: '   ',
    }),
    { reason: 'INVALID' }
  );
  assert.ok(!f.events.some((event) => Array.isArray(event) && event[0] === 'review'));
});

test('review rechecks import state after acquiring the commit lock', async () => {
  const f = setup('production', 'disabled');
  const menu = f.load('@/lib/restaurant/menu-import');
  f.record.status = 'AWAITING_REVIEW';
  f.db.$queryRaw = async () => {
    // Model a commit that held the parent lock first and completed while this
    // review was waiting. The post-lock read must observe its final state.
    f.record.status = 'COMMITTED';
    return [];
  };

  await assert.rejects(
    menu.reviewMenuImportLine(f.db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      priceAmount: '12.50',
    }),
    { reason: 'INVALID_STATE' }
  );
  assert.ok(f.events.includes('transaction'));
  assert.ok(!f.events.some((event) => Array.isArray(event) && event[0] === 'review'));
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
