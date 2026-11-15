/**
 * R-lane / WHA-194 — the OCR menu-import acceptance battery, on a real database.
 *
 * Everything here runs through the ACTUAL domain layer (`createMenuImport`,
 * `runMenuImportExtraction`, `reviewMenuImportLine`, `commitMenuImport`,
 * `discardMenuImport`, `purgeStaleMenuImports`) against a disposable PostgreSQL
 * as an UNPRIVILEGED role — NOSUPERUSER and NOBYPASSRLS, asked of `pg_roles`
 * rather than assumed. Anything proven with a bypassing role proves nothing
 * about tenancy.
 *
 * The named checks:
 *   - the role really is unprivileged, and forced RLS covers all three tables;
 *   - a second tenant can neither read nor write another's import, and a
 *     cross-tenant merge target is refused by the composite tenant key;
 *   - HUMAN REVIEW IS MANDATORY — commit refuses while any line is PENDING, and
 *     accept refuses a line with no name or no price rather than inventing one;
 *   - commit is one transaction: an injected failure leaves NO catalog row, no
 *     menu, and no price-list version behind;
 *   - commit is idempotent — a replay creates nothing and reports the first
 *     call's evidence;
 *   - extraction is idempotent and replay-safe: a second run converges on one
 *     set of candidates rather than a second copy;
 *   - upload validation rejects the wrong type, an over-page PDF and an empty
 *     file, and an identical re-upload resumes ONE draft;
 *   - cleanup: the source file is deleted on commit, on discard, and by the
 *     14-day purge, and the purge is safe to run twice;
 *   - NO SILENT PUBLISH — the menu has no branch publication and the price-list
 *     version is still DRAFT after a successful import;
 *   - the audit evidence is IDS ONLY: no extracted menu text reaches the
 *     recorded metadata, including from a line carrying an injection payload;
 *   - capability and module gating are default-deny for `menu:import`.
 *
 * Requires TEST_DATABASE_URL (or MENU_IMPORT_TEST_DATABASE_URL) — a migrated
 * throwaway database with an unprivileged application role, never DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL =
  process.env.MENU_IMPORT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgA = `org_wha194_a_${suffix}`;
const orgB = `org_wha194_b_${suffix}`;
const userA = `user_wha194_a_${suffix}`;
const userB = `user_wha194_b_${suffix}`;

const IMPORT_TABLES = [
  'restaurant_menu_imports',
  'restaurant_menu_import_pages',
  'restaurant_menu_import_lines',
] as const;

/** A byte-valid 1x1 PNG; fixture scenarios are appended as an ASCII marker. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function pdfOf(pages: number): Buffer {
  const objects = Array.from(
    { length: pages },
    (_, index) => `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`
  ).join('');
  return Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n${objects}%%EOF\n`,
    'latin1'
  );
}

type Deps = {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  menuImport: typeof import('@/lib/restaurant/menu-import');
  fixtures: typeof import('@/lib/restaurant/menu-extraction-fixtures');
  uploads: typeof import('@/lib/restaurant/menu-import-uploads');
  abac: typeof import('@/lib/abac');
  entitlements: typeof import('@/lib/entitlements');
  moduleCatalog: typeof import('@/lib/module-catalog');
};

let deps: Deps;
let dbA: import('@/lib/tenancy/scoped-db').ScopedDb;
let dbB: import('@/lib/tenancy/scoped-db').ScopedDb;

/**
 * An in-memory object store standing in for Azure Blob / the local disk. Keeps
 * the battery hermetic while still exercising the real retention CALLS — what is
 * being proven is that the domain deletes when it should, not that `fs` works.
 */
function memoryStore() {
  const objects = new Map<string, Buffer>();
  const deletions: string[] = [];
  const boundaryFailures = new Map<string, number>();
  return {
    objects,
    deletions,
    failOnce(boundary: string) {
      boundaryFailures.set(boundary, (boundaryFailures.get(boundary) ?? 0) + 1);
    },
    runtime: {
      resolveAdapter: () => deps.fixtures.createFixtureMenuExtractionAdapter(),
      putSource: async (org: string, name: string, content: Buffer) => {
        objects.set(`${org}/${name}`, content);
      },
      readSource: async (org: string, name: string) => {
        const found = objects.get(`${org}/${name}`);
        if (!found) throw new Error(`missing object ${org}/${name}`);
        return found;
      },
      deleteSource: async (org: string, name: string) => {
        deletions.push(`${org}/${name}`);
        objects.delete(`${org}/${name}`);
      },
      afterBoundary: async (boundary: string) => {
        const remaining = boundaryFailures.get(boundary) ?? 0;
        if (remaining > 0) {
          boundaryFailures.set(boundary, remaining - 1);
          throw new Error(`injected failure after ${boundary}`);
        }
      },
    } satisfies import('@/lib/restaurant/menu-import').MenuImportRuntime,
  };
}

let store: ReturnType<typeof memoryStore>;

/** Upload + extract in one step: the state every review scenario starts from. */
async function seedAwaitingReview(
  fixture: import('@/lib/restaurant/menu-extraction-fixtures').MenuFixtureKey,
  options: { db?: import('@/lib/tenancy/scoped-db').ScopedDb; org?: string; label?: string } = {}
) {
  const db = options.db ?? dbA;
  const org = options.org ?? orgA;
  const created = await deps.menuImport.createMenuImport(
    db,
    org,
    {
      fileName: `${fixture}.png`,
      content: deps.fixtures.withFixtureMarker(PNG, fixture),
      declaredMimeType: 'image/png',
      createdById: org === orgA ? userA : userB,
      adapter: 'FIXTURE',
      defaultCurrency: 'PKR',
      idempotencyKey: `${fixture}:${options.label ?? 'x'}:${randomBytes(4).toString('hex')}`,
    },
    { runtime: store.runtime }
  );
  await deps.menuImport.runMenuImportExtraction(db, created.importId, { runtime: store.runtime });
  return created.importId;
}

/**
 * Run raw SQL inside a tenant's RLS context. Without the GUC the policy denies
 * first and a constraint probe would never reach the constraint — which is a
 * true statement about RLS, but not the one a CHECK test is trying to make.
 */
async function asTenant<T>(
  client: Client,
  organizationId: string,
  work: () => Promise<T>
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.current_organization_id = '${organizationId}'`);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function linesOf(importId: string, db = dbA) {
  return db.restaurantMenuImportLine.findMany({
    where: { importId },
    orderBy: [{ pageId: 'asc' }, { sortOrder: 'asc' }],
  });
}

/** Decide every line the same way, so a scenario can get to a committable state. */
async function decideAll(
  importId: string,
  decision: 'ACCEPTED' | 'REJECTED',
  db = dbA,
  reviewer = userA
) {
  for (const line of await linesOf(importId, db)) {
    // DEV-175: accepting a line with extracted sizes confirms each size as shown.
    const sizes = line.extractedVariants as Array<{
      name: string;
      price: { amount: string | null };
    }>;
    await deps.menuImport.reviewMenuImportLine(db, {
      lineId: line.id,
      decision,
      reviewedById: reviewer,
      ...(decision === 'ACCEPTED' && sizes.length > 0
        ? { variants: sizes.map((size) => ({ name: size.name, priceAmount: size.price.amount })) }
        : {}),
    });
  }
}

describeIfDatabase('WHA-194 menu import acceptance (real PostgreSQL)', () => {
  let sql: Client;

  beforeAll(async () => {
    // Extraction and storage fail closed unless explicitly enabled (test/development only).
    vi.stubEnv('MENU_IMPORT_ADAPTER', 'FIXTURE');
    vi.stubEnv('STORAGE_ADAPTER', 'local');
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run the menu-import battery against a non-local database.');
    }

    deps = {
      createTenantDb: (await import('@/lib/tenancy/scoped-db')).createTenantDb,
      withTenantDb: (await import('@/lib/tenancy/scoped-db')).withTenantDb,
      menuImport: await import('@/lib/restaurant/menu-import'),
      fixtures: await import('@/lib/restaurant/menu-extraction-fixtures'),
      uploads: await import('@/lib/restaurant/menu-import-uploads'),
      abac: await import('@/lib/abac'),
      entitlements: await import('@/lib/entitlements'),
      moduleCatalog: await import('@/lib/module-catalog'),
    };
    store = memoryStore();

    sql = new Client({ connectionString: TEST_DATABASE_URL });
    await sql.connect();

    // Organizations are not org-scoped rows; seed them through the platform-admin
    // branch of the tenant policy, which is the same door the real bootstrap uses.
    await sql.query('BEGIN');
    await sql.query(`SET LOCAL app.is_platform_admin = 'true'`);
    for (const [id, slug] of [
      [orgA, `wha194a-${suffix}`],
      [orgB, `wha194b-${suffix}`],
    ]) {
      await sql.query(
        `INSERT INTO "organizations"
           ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "vertical", "currency", "createdAt", "updatedAt")
         VALUES ($1, $2, 'WHA194 Test Co', 'WHA194', 'ACTIVE', 'SHARED', 'RESTAURANT', 'PKR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, slug]
      );
    }
    await sql.query('COMMIT');

    dbA = deps.createTenantDb(orgA);
    dbB = deps.createTenantDb(orgB);

    for (const [org, db, user] of [
      [orgA, dbA, userA],
      [orgB, dbB, userB],
    ] as const) {
      await seedDepartments(db, [org], ['LEADERSHIP']);
      await db.user.create({
        data: {
          id: user,
          name: 'Menu Reviewer',
          email: `${user}@example.test`,
          department: 'LEADERSHIP',
          title: 'Manager',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
        },
      });
      void org;
    }
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql?.end();
  });

  // ── Tenancy floor ──────────────────────────────────────────────────────────

  it('runs as a LOGIN role that is neither SUPERUSER nor BYPASSRLS', async () => {
    const role = await sql.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

  it('forces row level security on every menu-import table', async () => {
    const rows = await sql.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [[...IMPORT_TABLES]]
    );
    expect(rows.rows).toHaveLength(IMPORT_TABLES.length);
    for (const row of rows.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('hides one tenant’s import from another, in reads and in writes', async () => {
    const importId = await seedAwaitingReview('default', { label: 'isolation' });

    expect(await dbA.restaurantMenuImport.findUnique({ where: { id: importId } })).not.toBeNull();
    expect(await dbB.restaurantMenuImport.findUnique({ where: { id: importId } })).toBeNull();
    expect(await dbB.restaurantMenuImportLine.count({ where: { importId } })).toBe(0);

    // An update aimed at the other tenant's row matches nothing at all.
    expect(
      await dbB.restaurantMenuImport.updateMany({
        where: { id: importId },
        data: { status: 'DISCARDED' },
      })
    ).toEqual({ count: 0 });
    expect((await dbA.restaurantMenuImport.findUnique({ where: { id: importId } }))?.status).toBe(
      'AWAITING_REVIEW'
    );
  });

  it('refuses a cross-tenant merge target at the domain and at the tenant key', async () => {
    const importId = await seedAwaitingReview('collision', { label: 'crosstenant' });
    const [line] = await linesOf(importId);
    const foreignProduct = await dbB.restaurantProduct.create({
      data: { name: `Foreign Dish ${suffix}` },
      select: { id: true },
    });

    // The domain resolves the target through tenant A's client, where it does
    // not exist — the caller is told the target is missing, not that it belongs
    // to somebody else.
    await expect(
      deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: line!.id,
        decision: 'MERGED',
        reviewedById: userA,
        mergeProductId: foreignProduct.id,
      })
    ).rejects.toMatchObject({ reason: 'MERGE_TARGET_NOT_FOUND' });

    // And the composite tenant key is the floor under that, for a write that
    // goes around the domain entirely.
    await expect(
      dbA.restaurantMenuImportLine.update({
        where: { id: line!.id },
        data: { mergeProductId: foreignProduct.id },
      })
    ).rejects.toThrow();
  });

  // ── Extraction ─────────────────────────────────────────────────────────────

  it('extracts asynchronously into a review queue, creating no catalog rows', async () => {
    const productsBefore = await dbA.restaurantProduct.count();
    const importId = await seedAwaitingReview('multipage', { label: 'async' });

    const record = await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } });
    expect(record.status).toBe('AWAITING_REVIEW');
    expect(record.adapterVersion).toBe(deps.fixtures.FIXTURE_ADAPTER_VERSION);
    expect(await dbA.restaurantMenuImportPage.count({ where: { importId } })).toBe(3);

    // Nothing sellable exists yet. This is the whole point of the queue.
    expect(await dbA.restaurantProduct.count()).toBe(productsBefore);
    expect(await dbA.restaurantMenu.count()).toBe(0);
  });

  it('is replay-safe: a second extraction converges on one set of candidates', async () => {
    const importId = await seedAwaitingReview('variants', { label: 'replay' });
    const first = await linesOf(importId);

    // Re-open and re-run, as a redelivered job would.
    await dbA.restaurantMenuImport.update({
      where: { id: importId },
      data: { status: 'PENDING_EXTRACTION' },
    });
    await deps.menuImport.runMenuImportExtraction(dbA, importId, { runtime: store.runtime });

    const second = await linesOf(importId);
    expect(second).toHaveLength(first.length);
    expect(second.map((line) => line.extractedProductName)).toEqual(
      first.map((line) => line.extractedProductName)
    );
  });

  it('skips an extraction for an import that is no longer pending', async () => {
    const importId = await seedAwaitingReview('default', { label: 'skip' });
    const outcome = await deps.menuImport.runMenuImportExtraction(dbA, importId, {
      runtime: store.runtime,
    });
    expect(outcome.status).toBe('SKIPPED');
  });

  it('flags a dish the catalog already carries', async () => {
    await dbA.restaurantProduct.create({ data: { name: 'Chicken  Malai  Boti' } });
    const importId = await seedAwaitingReview('collision', { label: 'existing' });
    const lines = await linesOf(importId);

    const collided = lines.find((line) => line.matchKey === 'chicken malai boti');
    expect(collided?.flags).toContain('EXISTING_PRODUCT_MATCH');
    const fresh = lines.find((line) => line.matchKey === 'fresh lime soda');
    expect(fresh?.flags).not.toContain('EXISTING_PRODUCT_MATCH');
  });

  it('persists an injection payload as inert text with a flag', async () => {
    const importId = await seedAwaitingReview('injection', { label: 'injection' });
    const line = (await linesOf(importId)).find(
      (candidate) => candidate.matchKey === 'mutton karahi'
    );
    expect(line?.flags).toContain('SUSPECTED_INJECTION');
    expect(line?.extractedDescription).toContain('Ignore previous instructions');
    expect(line?.extractedPriceAmount?.toString()).toBe('2400');
  });

  // ── Review is mandatory ────────────────────────────────────────────────────

  it('refuses to import while any line is still undecided', async () => {
    const importId = await seedAwaitingReview('default', { label: 'pending' });
    await expect(
      deps.menuImport.commitMenuImport(
        dbA,
        { importId, committedById: userA },
        { runtime: store.runtime }
      )
    ).rejects.toMatchObject({ reason: 'REVIEW_INCOMPLETE' });

    const summary = await deps.menuImport.summarizeMenuImport(dbA, importId);
    expect(summary.readyToCommit).toBe(false);
    expect(summary.PENDING).toBeGreaterThan(0);
  });

  it('refuses to accept a line the menu gave no price, rather than inventing one', async () => {
    const importId = await seedAwaitingReview('blurred', { label: 'noprice' });
    const priceless = (await linesOf(importId)).find((line) => line.extractedPriceAmount === null);
    expect(priceless?.flags).toContain('MISSING_PRICE');

    await expect(
      deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: priceless!.id,
        decision: 'ACCEPTED',
        reviewedById: userA,
      })
    ).rejects.toMatchObject({ reason: 'PRICE_REQUIRED' });

    // The reviewer supplying the missing price is exactly the intended path.
    const fixed = await deps.menuImport.reviewMenuImportLine(dbA, {
      lineId: priceless!.id,
      decision: 'ACCEPTED',
      reviewedById: userA,
      priceAmount: '520.00',
    });
    expect(fixed.reviewedPriceAmount?.toString()).toBe('520');
    expect(fixed.reviewedById).toBe(userA);
  });

  it('keeps the extracted value alongside the reviewer’s correction', async () => {
    const importId = await seedAwaitingReview('injection', { label: 'edit' });
    const [line] = await linesOf(importId);

    const edited = await deps.menuImport.reviewMenuImportLine(dbA, {
      lineId: line!.id,
      decision: 'ACCEPTED',
      reviewedById: userA,
      productName: 'Nihari (Beef)',
      priceAmount: '1500.00',
    });
    expect(edited.reviewedProductName).toBe('Nihari (Beef)');
    // The OCR record is never overwritten — the queue must show both.
    expect(edited.extractedProductName).toBe('Beef Nihari');
  });

  it('refuses to import when every line was rejected', async () => {
    const importId = await seedAwaitingReview('default', { label: 'allrejected' });
    await decideAll(importId, 'REJECTED');
    await expect(
      deps.menuImport.commitMenuImport(
        dbA,
        { importId, committedById: userA },
        { runtime: store.runtime }
      )
    ).rejects.toMatchObject({ reason: 'NOTHING_TO_IMPORT' });
  });

  it('rejects a merge target that is not a real product, and a merge on a non-merge decision', async () => {
    const importId = await seedAwaitingReview('default', { label: 'badmerge' });
    const [line] = await linesOf(importId);

    await expect(
      deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: line!.id,
        decision: 'MERGED',
        reviewedById: userA,
        mergeProductId: `nope_${suffix}`,
      })
    ).rejects.toMatchObject({ reason: 'MERGE_TARGET_NOT_FOUND' });

    await expect(
      deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: line!.id,
        decision: 'ACCEPTED',
        reviewedById: userA,
        mergeProductId: `nope_${suffix}`,
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  // ── Commit ─────────────────────────────────────────────────────────────────

  it.each(['EUR', 'USD'])(
    'requires a reviewed PKR amount before importing a %s price',
    async (currency) => {
      const importId = await seedAwaitingReview('locale', { label: `conversion-${currency}` });
      const lines = await linesOf(importId);
      const foreignLine = lines.find((line) => line.extractedCurrency === currency)!;
      expect(foreignLine).toBeDefined();
      for (const line of lines) {
        await deps.menuImport.reviewMenuImportLine(dbA, {
          lineId: line.id,
          decision: line.id === foreignLine.id ? 'ACCEPTED' : 'REJECTED',
          reviewedById: userA,
        });
      }

      const productsBefore = await dbA.restaurantProduct.count();
      const menusBefore = await dbA.restaurantMenu.count();
      const versionsBefore = await dbA.restaurantPriceListVersion.count();
      const commit = () =>
        deps.menuImport.commitMenuImport(
          dbA,
          { importId, committedById: userA },
          { runtime: store.runtime }
        );
      await expect(commit()).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });

      // Relabelling the extracted amount is not a reviewed conversion.
      await deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: foreignLine.id,
        decision: 'ACCEPTED',
        reviewedById: userA,
        currency: 'PKR',
      });
      await expect(commit()).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });

      // Re-submitting the extracted figure with a new currency is still a relabel.
      await deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: foreignLine.id,
        decision: 'ACCEPTED',
        reviewedById: userA,
        priceAmount: foreignLine.extractedPriceAmount!.toString(),
        currency: 'PKR',
      });
      await expect(commit()).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });

      // Sequential review: confirm the amount in the foreign currency, then change
      // only the currency (omitted amount, and the editor's prepopulated amount).
      // Neither turns the foreign figure into a local price.
      for (const relabel of [{}, { priceAmount: '13' }]) {
        await deps.menuImport.reviewMenuImportLine(dbA, {
          lineId: foreignLine.id,
          decision: 'ACCEPTED',
          reviewedById: userA,
          priceAmount: '13',
          currency,
        });
        await deps.menuImport.reviewMenuImportLine(dbA, {
          lineId: foreignLine.id,
          decision: 'ACCEPTED',
          reviewedById: userA,
          currency: 'PKR',
          ...relabel,
        });
        const relabelled = await dbA.restaurantMenuImportLine.findUniqueOrThrow({
          where: { id: foreignLine.id },
        });
        expect(relabelled.reviewedCurrency).toBe('PKR');
        expect(relabelled.reviewedPriceAmount).toBeNull();
        await expect(commit()).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });
      }

      // The same holds for a merged row.
      const [mergeTarget] = await dbA.restaurantProduct.findMany({ take: 1, select: { id: true } });
      if (mergeTarget) {
        await deps.menuImport.reviewMenuImportLine(dbA, {
          lineId: foreignLine.id,
          decision: 'MERGED',
          reviewedById: userA,
          mergeProductId: mergeTarget.id,
          priceAmount: '13',
          currency,
        });
        await deps.menuImport.reviewMenuImportLine(dbA, {
          lineId: foreignLine.id,
          decision: 'MERGED',
          reviewedById: userA,
          mergeProductId: mergeTarget.id,
          currency: 'PKR',
        });
        await expect(commit()).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });
      }
      expect(await dbA.restaurantProduct.count()).toBe(productsBefore);
      expect(await dbA.restaurantMenu.count()).toBe(menusBefore);
      expect(await dbA.restaurantPriceListVersion.count()).toBe(versionsBefore);

      await deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: foreignLine.id,
        decision: 'ACCEPTED',
        reviewedById: userA,
        priceAmount: '3500',
        currency: 'PKR',
      });
      const result = await commit();
      const entries = await dbA.restaurantPriceListEntry.findMany({
        where: { priceListVersionId: result.priceListVersionId },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.price.toString()).toBe('3500');
      const persisted = await dbA.restaurantMenuImportLine.findUniqueOrThrow({
        where: { id: foreignLine.id },
      });
      expect(persisted.extractedCurrency).toBe(currency);
      expect(persisted.reviewedCurrency).toBe('PKR');
    }
  );

  it('imports confirmed rows into catalog, a DRAFT menu and a DRAFT price version', async () => {
    const importId = await seedAwaitingReview('variants', { label: 'commit' });
    await decideAll(importId, 'ACCEPTED');

    const result = await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA, menuName: 'Imported Dinner' },
      { runtime: store.runtime }
    );

    expect(result.alreadyCommitted).toBe(false);
    expect(result.createdProductIds).toHaveLength(1);
    // Base price plus one per size.
    expect(result.priceEntryIds).toHaveLength(4);

    const product = await dbA.restaurantProduct.findUniqueOrThrow({
      where: { id: result.createdProductIds[0]! },
      include: { variants: true, category: true },
    });
    expect(product.name).toBe('Chicken Fajita Pizza');
    expect(product.category?.name).toBe('Pizza');
    expect(product.variants.map((variant) => variant.name).sort()).toEqual([
      'Large 15"',
      'Medium 12"',
      'Small 9"',
    ]);

    const menu = await dbA.restaurantMenu.findUniqueOrThrow({
      where: { id: result.menuId },
      include: { sections: { include: { items: true } }, publications: true },
    });
    expect(menu.name).toBe('Imported Dinner');
    // NO SILENT PUBLISH: nothing reaches a branch.
    expect(menu.publications).toEqual([]);
    expect(menu.sections.flatMap((section) => section.items)).toHaveLength(4);

    const version = await dbA.restaurantPriceListVersion.findUniqueOrThrow({
      where: { id: result.priceListVersionId },
    });
    expect(version.status).toBe('DRAFT');
    expect(version.activatedAt).toBeNull();
  });

  it('refuses to accept a line with sizes until every size is confirmed (DEV-175)', async () => {
    const importId = await seedAwaitingReview('variants', { label: 'unconfirmed-sizes' });
    const [line] = await linesOf(importId);
    await expect(
      deps.menuImport.reviewMenuImportLine(dbA, {
        lineId: line!.id,
        decision: 'ACCEPTED',
        reviewedById: userA,
      })
    ).rejects.toMatchObject({ reason: 'VARIANTS_REVIEW_REQUIRED' });

    await deps.menuImport.reviewMenuImportLine(dbA, {
      lineId: line!.id,
      decision: 'ACCEPTED',
      reviewedById: userA,
      variants: [{ name: 'Small 9"', priceAmount: '1250' }],
    });
    const result = await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA },
      { runtime: store.runtime }
    );
    const product = await dbA.restaurantProduct.findUniqueOrThrow({
      where: { id: result.createdProductIds[0]! },
      include: { variants: true },
    });
    expect(product.variants.map((variant) => variant.name)).toEqual(['Small 9"']);
    const entries = await dbA.restaurantPriceListEntry.findMany({
      where: { priceListVersionId: result.priceListVersionId, variantId: { not: null } },
    });
    expect(entries.map((entry) => entry.price.toString())).toEqual(['1250']);
  });

  it('merges into an existing product instead of duplicating it', async () => {
    const existing = await dbA.restaurantProduct.create({
      data: { name: `Merge Target ${suffix}` },
      select: { id: true, name: true },
    });
    const importId = await seedAwaitingReview('collision', { label: 'merge' });
    const lines = await linesOf(importId);

    await deps.menuImport.reviewMenuImportLine(dbA, {
      lineId: lines[0]!.id,
      decision: 'MERGED',
      reviewedById: userA,
      mergeProductId: existing.id,
    });
    await deps.menuImport.reviewMenuImportLine(dbA, {
      lineId: lines[1]!.id,
      decision: 'REJECTED',
      reviewedById: userA,
    });

    const result = await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA },
      { runtime: store.runtime }
    );

    expect(result.createdProductIds).toEqual([]);
    expect(result.mergedProductIds).toEqual([existing.id]);
    // The curated product is untouched; the import only added a draft price.
    expect(
      (await dbA.restaurantProduct.findUniqueOrThrow({ where: { id: existing.id } })).name
    ).toBe(existing.name);
    expect(
      await dbA.restaurantPriceListEntry.count({
        where: { priceListVersionId: result.priceListVersionId, productId: existing.id },
      })
    ).toBe(1);
  });

  it('rolls the whole import back when any step fails', async () => {
    const importId = await seedAwaitingReview('default', { label: 'rollback' });
    await decideAll(importId, 'ACCEPTED');

    const productsBefore = await dbA.restaurantProduct.count();
    const menusBefore = await dbA.restaurantMenu.count();
    const versionsBefore = await dbA.restaurantPriceListVersion.count();

    // A duplicate effective instant makes `createPriceListVersion` throw mid-commit,
    // after the menu and the first products have already been written.
    const priceList = await dbA.restaurantPriceList.findFirst({ where: { isDefault: true } });
    const clashAt = new Date('2031-07-01T00:00:00.000Z');
    await dbA.restaurantPriceListVersion.create({
      data: {
        priceListId: priceList!.id,
        versionNumber: 9_000,
        effectiveFrom: clashAt,
        status: 'DRAFT',
      },
    });

    await expect(
      deps.menuImport.commitMenuImport(
        dbA,
        { importId, committedById: userA, effectiveFrom: clashAt },
        { runtime: store.runtime }
      )
    ).rejects.toThrow();

    // Nothing partial survived: the menu, the products and the version are all gone.
    expect(await dbA.restaurantProduct.count()).toBe(productsBefore);
    expect(await dbA.restaurantMenu.count()).toBe(menusBefore);
    expect(await dbA.restaurantPriceListVersion.count()).toBe(versionsBefore + 1); // only the clash row
    expect(
      (await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } })).status
    ).toBe('AWAITING_REVIEW');
  });

  it('is idempotent on commit: a replay creates nothing and reports the same evidence', async () => {
    const importId = await seedAwaitingReview('default', { label: 'idempotent' });
    await decideAll(importId, 'ACCEPTED');

    const first = await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA },
      { runtime: store.runtime }
    );
    const productsAfterFirst = await dbA.restaurantProduct.count();
    const menusAfterFirst = await dbA.restaurantMenu.count();

    const replay = await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA },
      { runtime: store.runtime }
    );

    expect(replay.alreadyCommitted).toBe(true);
    expect(replay.menuId).toBe(first.menuId);
    expect(replay.priceListVersionId).toBe(first.priceListVersionId);
    expect(replay.createdProductIds.sort()).toEqual(first.createdProductIds.sort());
    expect(await dbA.restaurantProduct.count()).toBe(productsAfterFirst);
    expect(await dbA.restaurantMenu.count()).toBe(menusAfterFirst);
  });

  it('records ids-only commit evidence on every imported line', async () => {
    const importId = await seedAwaitingReview('default', { label: 'evidence' });
    await decideAll(importId, 'ACCEPTED');
    const result = await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA },
      { runtime: store.runtime }
    );

    for (const line of await linesOf(importId)) {
      expect(line.committedProductId).toBeTruthy();
      expect(line.committedMenuItemId).toBeTruthy();
      expect(line.committedPriceEntryId).toBeTruthy();
      expect(result.createdProductIds).toContain(line.committedProductId!);
    }

    const record = await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } });
    expect(record.committedById).toBe(userA);
    expect(record.committedAt).not.toBeNull();
  });

  it('refuses to import an import that is not awaiting review', async () => {
    const importId = await seedAwaitingReview('default', { label: 'state' });
    await deps.menuImport.discardMenuImport(dbA, importId, userA, { runtime: store.runtime });
    await expect(
      deps.menuImport.commitMenuImport(
        dbA,
        { importId, committedById: userA },
        { runtime: store.runtime }
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  // ── Validation and upload idempotency ──────────────────────────────────────

  it('rejects an unsupported file, a mislabelled one, an empty one and an over-page PDF', async () => {
    const attempts: Array<[Buffer, string | null, string]> = [
      [Buffer.from('not a menu at all', 'latin1'), 'image/png', 'UNSUPPORTED_TYPE'],
      [PNG, 'application/pdf', 'TYPE_MISMATCH'],
      [Buffer.alloc(0), 'image/png', 'EMPTY'],
      [pdfOf(deps.uploads.MAX_PAGES_PER_IMPORT + 1), 'application/pdf', 'TOO_MANY_PAGES'],
    ];
    for (const [content, declaredMimeType, reason] of attempts) {
      await expect(
        deps.menuImport.createMenuImport(
          dbA,
          orgA,
          { fileName: 'bad', content, declaredMimeType, createdById: userA, adapter: 'FIXTURE' },
          { runtime: store.runtime }
        ),
        reason
      ).rejects.toMatchObject({ reason });
    }
    // A rejected upload leaves nothing behind in storage or in the queue.
    expect([...store.objects.keys()].some((key) => key.includes('bad'))).toBe(false);
  });

  it('resumes one draft when the same file is uploaded twice', async () => {
    const content = deps.fixtures.withFixtureMarker(PNG, 'default');
    const first = await deps.menuImport.createMenuImport(
      dbA,
      orgA,
      { fileName: 'menu.png', content, createdById: userA, adapter: 'FIXTURE' },
      { runtime: store.runtime }
    );
    const second = await deps.menuImport.createMenuImport(
      dbA,
      orgA,
      { fileName: 'menu-again.png', content, createdById: userA, adapter: 'FIXTURE' },
      { runtime: store.runtime }
    );

    expect(second.deduplicated).toBe(true);
    expect(second.importId).toBe(first.importId);
  });

  it.each(['row-created', 'upload-stored', 'enqueue', 'metadata-recorded'])(
    'resumes creation after an injected %s failure',
    async (boundary) => {
      const content = deps.fixtures.withFixtureMarker(PNG, 'default');
      const idempotencyKey = `resume-${boundary}-${suffix}`;
      store.failOnce(boundary);

      await expect(
        deps.menuImport.createMenuImport(
          dbA,
          orgA,
          {
            fileName: 'resume.png',
            content,
            createdById: userA,
            adapter: 'FIXTURE',
            idempotencyKey,
          },
          { runtime: store.runtime }
        )
      ).rejects.toThrow(`injected failure after ${boundary}`);

      const resumed = await deps.menuImport.createMenuImport(
        dbA,
        orgA,
        {
          fileName: 'resume.png',
          content,
          createdById: userA,
          adapter: 'FIXTURE',
          idempotencyKey,
        },
        { runtime: store.runtime }
      );
      const record = await dbA.restaurantMenuImport.findUniqueOrThrow({
        where: { id: resumed.importId },
      });
      expect(resumed.deduplicated).toBe(true);
      expect(record.storageObjectName).toBeTruthy();
      expect(record.extractionJobId).toBeTruthy();
      expect(await dbA.restaurantMenuImport.count({ where: { idempotencyKey } })).toBe(1);
      expect(
        await dbA.restaurantJob.count({
          where: {
            idempotencyKey: `${deps.menuImport.MENU_IMPORT_EXTRACT_JOB}:${resumed.importId}`,
          },
        })
      ).toBe(1);
      expect(store.objects.has(`${orgA}/${record.storageObjectName}`)).toBe(true);
    }
  );

  it('converges concurrent same-key retries and keeps the key tenant-scoped', async () => {
    const content = deps.fixtures.withFixtureMarker(PNG, 'default');
    const idempotencyKey = `concurrent-${suffix}`;
    const input = {
      fileName: 'concurrent.png',
      content,
      adapter: 'FIXTURE' as const,
      idempotencyKey,
    };
    const [left, right] = await Promise.all([
      deps.menuImport.createMenuImport(
        dbA,
        orgA,
        { ...input, createdById: userA },
        { runtime: store.runtime }
      ),
      deps.menuImport.createMenuImport(
        dbA,
        orgA,
        { ...input, createdById: userA },
        { runtime: store.runtime }
      ),
    ]);
    expect(left.importId).toBe(right.importId);
    expect(await dbA.restaurantMenuImport.count({ where: { idempotencyKey } })).toBe(1);

    const tenantB = await deps.menuImport.createMenuImport(
      dbB,
      orgB,
      { ...input, createdById: userB },
      { runtime: store.runtime }
    );
    expect(tenantB.importId).not.toBe(left.importId);
    expect(await dbB.restaurantMenuImport.count({ where: { idempotencyKey } })).toBe(1);
  });

  it('refuses to silently re-import a file that was already committed', async () => {
    const content = deps.fixtures.withFixtureMarker(PNG, 'blurred');
    const created = await deps.menuImport.createMenuImport(
      dbA,
      orgA,
      { fileName: 'once.png', content, createdById: userA, adapter: 'FIXTURE' },
      { runtime: store.runtime }
    );
    await deps.menuImport.runMenuImportExtraction(dbA, created.importId, {
      runtime: store.runtime,
    });
    await decideAll(created.importId, 'REJECTED');
    await deps.menuImport.discardMenuImport(dbA, created.importId, userA, {
      runtime: store.runtime,
    });

    await expect(
      deps.menuImport.createMenuImport(
        dbA,
        orgA,
        { fileName: 'once.png', content, createdById: userA, adapter: 'FIXTURE' },
        { runtime: store.runtime }
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_IMPORTED' });

    // An explicit key is the documented way to import the same menu again.
    const again = await deps.menuImport.createMenuImport(
      dbA,
      orgA,
      {
        fileName: 'once.png',
        content,
        createdById: userA,
        adapter: 'FIXTURE',
        idempotencyKey: `deliberate-reimport-${suffix}`,
      },
      { runtime: store.runtime }
    );
    expect(again.importId).not.toBe(created.importId);
  });

  it('enforces the size and page ceilings in the database as well as the validator', async () => {
    const insert = (id: string, byteSize: number, pageCount: number) =>
      asTenant(sql, orgA, () =>
        sql.query(
          `INSERT INTO "restaurant_menu_imports"
             ("id","organizationId","adapter","fileName","mimeType","byteSize","pageCount","checksum","idempotencyKey","createdById","updatedAt")
           VALUES ($1,$2,'FIXTURE','probe.pdf','application/pdf',$3,$4,'abc',$5,$6,CURRENT_TIMESTAMP)`,
          [id, orgA, byteSize, pageCount, `${id}_key`, userA]
        )
      );

    await expect(insert(`imp_huge_${suffix}`, 999_999_999, 1)).rejects.toThrow(/byteSize/);
    await expect(insert(`imp_long_${suffix}`, 1_024, 99)).rejects.toThrow(/pageCount/);
    // A row inside both ceilings still lands, so the CHECKs are bounds and not a
    // blanket refusal.
    await expect(insert(`imp_ok_${suffix}`, 1_024, 3)).resolves.toBeTruthy();
  });

  // ── Retention and cleanup ──────────────────────────────────────────────────

  it('deletes the uploaded file on commit', async () => {
    const importId = await seedAwaitingReview('default', { label: 'cleanupcommit' });
    const before = await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } });
    expect(store.objects.has(`${orgA}/${before.storageObjectName}`)).toBe(true);

    await decideAll(importId, 'ACCEPTED');
    await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA },
      { runtime: store.runtime }
    );

    const after = await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } });
    expect(store.objects.has(`${orgA}/${before.storageObjectName}`)).toBe(false);
    expect(after.storageObjectName).toBeNull();
    expect(after.sourceDeletedAt).not.toBeNull();
  });

  it.each(['committed-before-delete', 'source-deleted'])(
    'replays committed source cleanup after an injected %s failure',
    async (boundary) => {
      const importId = await seedAwaitingReview('default', { label: `cleanup-${boundary}` });
      await decideAll(importId, 'ACCEPTED');
      store.failOnce(boundary);

      await expect(
        deps.menuImport.commitMenuImport(
          dbA,
          { importId, committedById: userA },
          { runtime: store.runtime }
        )
      ).rejects.toThrow(`injected failure after ${boundary}`);
      expect(
        (await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } })).status
      ).toBe('COMMITTED');

      const replay = await deps.menuImport.commitMenuImport(
        dbA,
        { importId, committedById: userA },
        { runtime: store.runtime }
      );
      const cleaned = await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } });
      expect(replay.alreadyCommitted).toBe(true);
      expect(cleaned.storageObjectName).toBeNull();
      expect(cleaned.sourceDeletedAt).not.toBeNull();
    }
  );

  it('deletes the uploaded file on discard but keeps the review record', async () => {
    const importId = await seedAwaitingReview('default', { label: 'cleanupdiscard' });
    const before = await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } });
    const lineCount = await dbA.restaurantMenuImportLine.count({ where: { importId } });

    const discarded = await deps.menuImport.discardMenuImport(dbA, importId, userA, {
      runtime: store.runtime,
    });
    expect(discarded.alreadyDiscarded).toBe(false);
    expect(store.objects.has(`${orgA}/${before.storageObjectName}`)).toBe(false);
    // The record of what was seen and declined is retained.
    expect(await dbA.restaurantMenuImportLine.count({ where: { importId } })).toBe(lineCount);

    // Discarding twice is a no-op, not an error.
    expect(
      (await deps.menuImport.discardMenuImport(dbA, importId, userA, { runtime: store.runtime }))
        .alreadyDiscarded
    ).toBe(true);
  });

  it('purges drafts abandoned past the retention window, and is safe to run twice', async () => {
    const importId = await seedAwaitingReview('default', { label: 'purge' });
    const record = await dbA.restaurantMenuImport.findUniqueOrThrow({ where: { id: importId } });
    const objectKey = `${orgA}/${record.storageObjectName}`;

    const fresh = await deps.menuImport.purgeStaleMenuImports(dbA, { runtime: store.runtime });
    expect(fresh.purgedDrafts).toBe(0);
    expect(store.objects.has(objectKey)).toBe(true);

    // Age the draft past the window.
    const aged = new Date(
      Date.now() - (deps.menuImport.MENU_IMPORT_DRAFT_TTL_DAYS + 1) * 24 * 60 * 60 * 1_000
    );
    await asTenant(sql, orgA, () =>
      sql.query('UPDATE "restaurant_menu_imports" SET "createdAt" = $1 WHERE "id" = $2', [
        aged,
        importId,
      ])
    );

    const purged = await deps.menuImport.purgeStaleMenuImports(dbA, { runtime: store.runtime });
    expect(purged.purgedDrafts).toBeGreaterThanOrEqual(1);
    expect(store.objects.has(objectKey)).toBe(false);
    expect(await dbA.restaurantMenuImport.findUnique({ where: { id: importId } })).toBeNull();
    // Lines cascade with the draft.
    expect(await dbA.restaurantMenuImportLine.count({ where: { importId } })).toBe(0);

    // Idempotent: a second sweep finds nothing left to do and does not throw.
    await expect(
      deps.menuImport.purgeStaleMenuImports(dbA, { runtime: store.runtime })
    ).resolves.toMatchObject({ purgedDrafts: 0 });
  });

  it('leaves no menu-import source file behind for any decided import', async () => {
    await deps.menuImport.purgeStaleMenuImports(dbA, { runtime: store.runtime });
    const retained = await dbA.restaurantMenuImport.findMany({
      where: { status: { in: ['COMMITTED', 'DISCARDED'] } },
      select: { storageObjectName: true },
    });
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((row) => row.storageObjectName === null)).toBe(true);
  });

  // ── Authorization ──────────────────────────────────────────────────────────

  it('denies menu:import by default and grants it only through an organization role', async () => {
    const subject = { id: userA, role: 'EMPLOYEE', department: null, status: 'ACTIVE' };

    // Default deny: no organization role, no override, no static agency policy.
    await expect(deps.abac.can(subject, 'menu:import', undefined, { db: dbA })).resolves.toBe(
      false
    );

    // An agency ADMIN is still not granted a restaurant capability.
    await expect(
      deps.abac.can({ ...subject, role: 'ADMIN' }, 'menu:import', undefined, { db: dbA })
    ).resolves.toBe(false);

    const role = await dbA.organizationRole.create({
      data: {
        key: `menu-importer-${suffix}`,
        name: 'Menu Importer',
        permissions: { create: [{ capability: 'menu:import', effect: 'ALLOW' }] },
      },
      select: { id: true },
    });
    await dbA.user.update({ where: { id: userA }, data: { organizationRoleId: role.id } });

    await expect(deps.abac.can(subject, 'menu:import', undefined, { db: dbA })).resolves.toBe(true);
    // Holding menu:import does not confer the wider catalog write capability.
    await expect(deps.abac.can(subject, 'menu:write', undefined, { db: dbA })).resolves.toBe(false);

    await dbA.user.update({ where: { id: userA }, data: { organizationRoleId: null } });
  });

  it('gates the import surface on the restaurant-menu module entitlement', async () => {
    expect(deps.moduleCatalog.moduleForProcedure('restaurantMenuImport.upload')).toBe(
      'restaurant-menu'
    );
    const view = await deps.entitlements.resolveOrganizationEntitlements(orgA, dbA);
    // The test organization licenses nothing, so the module guard denies.
    expect(deps.entitlements.hasModule(view, 'restaurant-menu')).toBe(false);
  });

  // ── Audit evidence is ids only ─────────────────────────────────────────────

  it('never lets extracted menu text into the recorded commit evidence', async () => {
    const importId = await seedAwaitingReview('injection', { label: 'audit' });
    await decideAll(importId, 'ACCEPTED');
    const result = await deps.menuImport.commitMenuImport(
      dbA,
      { importId, committedById: userA },
      { runtime: store.runtime }
    );

    // This is exactly what the router hands to `annotateAudit`.
    const evidence = JSON.stringify({
      menuId: result.menuId,
      priceListVersionId: result.priceListVersionId,
      createdProductIds: result.createdProductIds,
      createdCategoryIds: result.createdCategoryIds,
      mergedProductIds: result.mergedProductIds,
      priceEntryIds: result.priceEntryIds,
    });

    expect(evidence).not.toMatch(/ignore previous instructions/i);
    expect(evidence).not.toContain('Mutton Karahi');
    expect(evidence).not.toContain('Nihari');
    // Everything it does carry is an identifier.
    for (const id of [
      result.menuId,
      result.priceListVersionId,
      ...result.createdProductIds,
      ...result.priceEntryIds,
    ]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
