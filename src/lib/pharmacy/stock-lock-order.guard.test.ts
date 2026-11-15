/**
 * DEV-825 — guard: every explicit stock-row lock (batch, medicine, lot,
 * balance) and the controlled-register lock is taken through
 * stock-lock-order.ts, which sorts its keys and takes the classes in the one
 * global order. A locking clause on those rows anywhere else could take them in
 * its own order and deadlock against the rest, so it fails this test.
 *
 * It only sees explicit locking clauses in source. It cannot see the row locks
 * a write takes implicitly (a movement insert locking its balance through the
 * projection trigger, an insert's FOR KEY SHARE on the rows it references):
 * the per-path tests in stock-lock-order.test.ts and
 * stock-lock-order.paths.test.ts assert those paths lock first, in order.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(__dirname, '..', '..');
const HELPER = join('lib', 'pharmacy', 'stock-lock-order.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const STOCK_TABLES =
  /pharmacy_stock_balances|pharmacy_inventory_lots|pharmacy_manufacturing_batches|pharmacy_medicines/;
/** Aliases the pharmacy stock queries give those tables. */
const STOCK_ALIASES = new Set(['balance', 'bal', 'b', 'lot', 'l', 'batch', 'mb', 'medicine']);
const LOCK_CLAUSE = /FOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)(?:\s+OF\s+([\w",\s]+))?/g;
const REGISTER_LOCK =
  /pg_advisory_xact_lock\(\s*hashtextextended\(\s*\$\{\s*[\w.]+\s*\+\s*':'\s*\+\s*[\w.]*branchId\s*\}/;

/** Every stock-row locking clause or register lock outside the helper, as file:line. */
function stockLockOffenders(files: Array<{ path: string; text: string }>) {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    if (path === HELPER) continue;
    const at = (index: number) => `${path}:${text.slice(0, index).split('\n').length}`;
    for (const match of text.matchAll(LOCK_CLAUSE)) {
      const index = match.index ?? 0;
      // The statement the clause belongs to: back to the call or declaration that
      // builds it, so nested template fragments do not hide its tables.
      const start = Math.max(
        ...['$queryRaw', '$executeRaw', 'const ', 'return '].map((marker) =>
          text.lastIndexOf(marker, index)
        )
      );
      const statement = text.slice(Math.max(start, 0), index);
      const aliases = (match[1] ?? '')
        .split(',')
        .map((alias) => alias.replace(/"/g, '').trim().split(/\s+/)[0]!)
        .filter(Boolean);
      const lockedAliases = aliases.filter((alias) => STOCK_ALIASES.has(alias));
      const stockStatement = STOCK_TABLES.test(statement);
      if (aliases.length ? lockedAliases.length > 0 && /pharmacy/.test(path) : stockStatement)
        offenders.push(at(index));
    }
    for (const match of text.matchAll(new RegExp(REGISTER_LOCK, 'g')))
      offenders.push(at(match.index ?? 0));
  }
  return offenders;
}

/** Blank out comments (keeping line numbers) so prose about locks is not scanned. */
function withoutComments(text: string) {
  const blank = (comment: string) => comment.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^\s*\/\/.*$/gm, blank);
}

const files = sourceFiles(srcRoot).map((path) => ({
  path: path.slice(srcRoot.length + 1),
  text: withoutComments(readFileSync(path, 'utf8')),
}));

describe('stock locks go through the shared lock-order helper', () => {
  it('finds no stock-row or register lock outside stock-lock-order.ts', () => {
    expect(stockLockOffenders(files)).toEqual([]);
  });

  it('scans the real lock sites (the helper itself would be caught)', () => {
    const helper = files.find(({ path }) => path === HELPER)!;
    // Its two balance statements and the register lock (the batch, medicine and
    // lot clauses are built by `rowLock`, outside any stock statement's text).
    const caught = stockLockOffenders([{ ...helper, path: 'lib/pharmacy/elsewhere.ts' }]);
    expect(caught).toHaveLength(3);
  });

  it.each([
    ['a joined lock', 'sql`SELECT 1 FROM x ${JOINS} FOR UPDATE OF balance`'],
    [
      'a plain stock-table lock',
      'sql`SELECT id FROM "pharmacy_inventory_lots" WHERE id=1 FOR UPDATE`',
    ],
    [
      'a shared batch lock',
      'sql`SELECT 1 FROM pharmacy_inventory_lots l JOIN y mb ON 1=1 FOR SHARE OF mb`',
    ],
    [
      'an inline register lock',
      "db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':' + scope.branchId},0))`",
    ],
  ])('flags %s', (_label, text) => {
    expect(stockLockOffenders([{ path: 'lib/pharmacy/example.ts', text }])).toHaveLength(1);
  });

  it.each([
    ['a document lock', 'sql`SELECT id FROM pharmacy_sales WHERE id=1 FOR UPDATE`'],
    ['a reservation lock', 'sql`${query} FOR UPDATE OF reservation`'],
    [
      'a request-scoped advisory lock',
      "sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':return:' + key}, 0))`",
    ],
  ])('allows %s', (_label, text) => {
    expect(stockLockOffenders([{ path: 'lib/pharmacy/example.ts', text }])).toEqual([]);
  });
});

/**
 * DEV-825 — second guard, for the locks the first one cannot see. A stock
 * movement write locks its balance implicitly through the projection trigger,
 * so every function that writes one must take its balance locks through the
 * shared helper before its first write — or be listed below with the reason it
 * needs none. A new writer that is in neither list fails until it is decided.
 */
/** Wrappers that take helper locks before anything else; each is checked below. */
const LOCKING_WRAPPERS = ['lockSaleCandidates', 'loadCandidates', 'manualQuarantineBalance'];
const LOCK_HELPER_CALL = new RegExp(
  `\\b(lockStockBalances|lockStockRowsFrom|${LOCKING_WRAPPERS.join('|')})\\(`
);
const MOVEMENT_WRITE = /pharmacyStockMovement\.(create|createMany|upsert)\(/g;

/** Writers that lock through the helper before their first write. */
const LOCKING_WRITERS = new Set([
  'approveCount',
  'breakPack',
  'dispatchPurchaseReturn',
  'dispatchTransfer',
  'quarantinePart',
  'receiveTransferLine',
  'receiveTransferWithVariance',
  'releaseQuarantinedPart',
  'returnSaleLine',
  'reverseMovements',
  'reverseRecallQuarantine',
  'transferStock',
  'writeOff',
]);

/** Writers that take no lock of their own, and why that is safe. */
const EXEMPT_WRITERS: Record<string, string> = {
  postReceipt:
    'writes only the balances of a lot it creates in the same transaction (goods-in receiveLot)',
  postOpeningSession: 'writes only the balances of opening lots it creates in the same transaction',
  postSaleMovements:
    'its callers (allocateForSale, allocateReservedForSale, the emergency shortfall) lock every candidate balance first',
};

function movementWriters(sources: Array<{ path: string; text: string }>) {
  const writers = new Map<string, { path: string; locksFirst: boolean }>();
  for (const { path, text } of sources) {
    for (const write of text.matchAll(MOVEMENT_WRITE)) {
      const before = text.slice(0, write.index);
      const declarations = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*[<(]/g)];
      const declaration = declarations.at(-1);
      const name = declaration?.[1] ?? `${path}:<top level>`;
      const body = before.slice(declaration?.index ?? 0);
      const locksFirst = LOCK_HELPER_CALL.test(body);
      const seen = writers.get(name);
      // A function locks first only if it does so before every write in it.
      writers.set(name, { path, locksFirst: (seen?.locksFirst ?? true) && locksFirst });
    }
  }
  return writers;
}

describe('every stock-movement writer locks through the shared helper first', () => {
  const writers = movementWriters(files);

  it('knows every function that writes a stock movement', () => {
    const unknown = [...writers.keys()].filter(
      (name) => !LOCKING_WRITERS.has(name) && !(name in EXEMPT_WRITERS)
    );
    expect(unknown).toEqual([]);
  });

  it('has no stale entries', () => {
    const listed = [...LOCKING_WRITERS, ...Object.keys(EXEMPT_WRITERS)];
    expect(listed.filter((name) => !writers.has(name))).toEqual([]);
  });

  it.each([...LOCKING_WRITERS])('%s calls the lock helper before its first write', (name) => {
    expect(writers.get(name)).toMatchObject({ locksFirst: true });
  });

  it.each(LOCKING_WRAPPERS)('wrapper %s calls the lock helper', (name) => {
    const source = files.find(({ text }) => new RegExp(`function\\s+${name}\\s*\\(`).test(text))!;
    const start = source.text.search(new RegExp(`function\\s+${name}\\s*\\(`));
    const body = source.text.slice(start, source.text.indexOf('\n}\n', start));
    expect(body).toMatch(/\b(lockStockBalances|lockStockRowsFrom|lockSaleCandidates)\(/);
  });

  it('flags a writer that writes before it locks', () => {
    const late = movementWriters([
      {
        path: 'lib/pharmacy/example.ts',
        text: `async function late(db) {
          await db.pharmacyStockMovement.create({ data: {} });
          await lockStockBalances(db, scope, keys);
        }`,
      },
    ]);
    expect(late.get('late')).toMatchObject({ locksFirst: false });
  });
});
