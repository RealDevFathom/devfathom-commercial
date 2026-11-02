import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Like vitest.server-only.ts, omit Next's marker outside the server runtime.
// Node's built-in transform runs the actual module without installing dependencies.
const source = await readFile(new URL('../src/lib/pharmacy/retention.ts', import.meta.url), 'utf8');
const javascript = stripTypeScriptTypes(source.replace("import 'server-only';", ''), { mode: 'transform' });
const {
  activeLegalHoldKeys,
  assertPharmacyRecordDeletable,
  pharmacyRetentionStatus,
  runPharmacyRetentionPurge,
} = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const scope = { organizationId: 'tenant-1', branchId: 'branch-1' };
const deadline = new Date('2026-01-01T00:00:00Z');
const eligible = { retentionUntil: deadline, checkedAt: deadline, blockedReason: null };

function database(statuses = {}) {
  const calls = [];
  const deleted = [];
  const savepoints = new Map();
  const tx = {
    async $executeRawUnsafe(sql) {
      const name = sql.split(' ').at(-1);
      if (sql.startsWith('SAVEPOINT ')) savepoints.set(name, [...deleted]);
      else if (sql.startsWith('ROLLBACK TO ')) deleted.splice(0, deleted.length, ...savepoints.get(name));
      else if (sql.startsWith('RELEASE ')) savepoints.delete(name);
      else throw new Error(`Unexpected transaction control: ${sql}`);
    },
    async $queryRaw(strings, ...parameters) {
      const sql = strings.join('?');
      calls.push({ sql, parameters });
      if (sql.includes('pharmacy_lock_retention')) return [];
      return [statuses[parameters[2]] ?? eligible];
    },
  };
  return {
    calls,
    deleted,
    tx,
    async $transaction(run) {
      // ScopedDb's nested transaction is only a callback, without automatic rollback.
      return run(tx);
    },
    $queryRaw: tx.$queryRaw,
  };
}

function owner(db, ids, recordClass = 'FISCAL') {
  return {
    recordClass,
    async candidates(tx, receivedScope, limit) {
      assert.equal(tx, db.tx);
      assert.equal(receivedScope, scope);
      assert.match(db.calls[0].sql, /pharmacy_lock_retention/);
      return ids.slice(0, limit);
    },
    async deleteAggregate(tx, receivedScope, id) {
      assert.equal(tx, db.tx);
      assert.equal(receivedScope, scope);
      assert.equal(db.calls.at(-1).parameters[2], id);
      db.deleted.push(id);
    },
  };
}

test('exact deadline is eligible; one millisecond before it is retained with explicit deadline', async () => {
  const db = database({ early: { ...eligible, checkedAt: new Date(deadline.getTime() - 1) } });
  assert.equal((await pharmacyRetentionStatus(db, scope, 'FISCAL', 'boundary')).eligible, true);
  await assert.rejects(assertPharmacyRecordDeletable(db, 'FISCAL', 'early', scope), (error) => {
    assert.equal(error.retentionUntil, deadline);
    assert.match(error.message, /2026-01-01T00:00:00.000Z/);
    return true;
  });
  assert.deepEqual(db.calls[0].parameters, ['tenant-1', 'FISCAL', 'boundary', 'branch-1']);
});

test('missing policy and legal hold remain blocked even after a nominal deadline', async () => {
  for (const reason of ['missing confirmed retention policy', 'record protected by legal hold']) {
    const db = database({ blocked: { ...eligible, blockedReason: reason } });
    await assert.rejects(assertPharmacyRecordDeletable(db, 'PRESCRIPTION', 'blocked', scope), {
      message: `Deletion refused: ${reason}`,
    });
  }
});

test('malformed or absent database policy responses fail closed', async () => {
  for (const status of [
    {},
    { ...eligible, retentionUntil: null },
    { ...eligible, retentionUntil: new Date(NaN) },
    { ...eligible, checkedAt: new Date(NaN) },
    { ...eligible, blockedReason: false },
  ]) {
    await assert.rejects(pharmacyRetentionStatus(database({ bad: status }), scope, 'AUDIT', 'bad'));
  }
  await assert.rejects(pharmacyRetentionStatus({ async $queryRaw() { return []; } }, scope, 'AUDIT', 'bad'));
});

test('latest hold state preserves independent cases and released holds', async () => {
  const db = { pharmacyLegalHoldEvent: { async findMany(query) {
    assert.deepEqual(query.where, { recordClass: 'AUDIT', recordId: 'record-1' });
    return [
      { holdKey: 'case-a', kind: 'PLACED' },
      { holdKey: 'case-b', kind: 'PLACED' },
      { holdKey: 'case-a', kind: 'RELEASED' },
    ];
  } } };
  assert.deepEqual(await activeLegalHoldKeys(db, 'AUDIT', 'record-1'), ['case-b']);
});

test('purge locks before scan, revalidates each candidate, skips held and unexpired records', async () => {
  const db = database({
    held: { ...eligible, blockedReason: 'legal hold' },
    young: { ...eligible, checkedAt: new Date(deadline.getTime() - 1) },
  });
  const result = await runPharmacyRetentionPurge(db, scope, [owner(db, ['held', 'young', 'old'])]);
  assert.deepEqual(result, { examined: 3, deleted: 1, blocked: 2 });
  assert.deepEqual(db.deleted, ['old']);
});

test('total candidate budget spans owners, including ineligible records', async () => {
  const db = database({ held: { ...eligible, blockedReason: 'legal hold' } });
  const result = await runPharmacyRetentionPurge(db, scope, [
    owner(db, ['held', 'sale-1']), owner(db, ['audit-1', 'audit-2'], 'AUDIT'),
  ], 3);
  assert.deepEqual(result, { examined: 3, deleted: 2, blocked: 1 });
  assert.deepEqual(db.deleted, ['sale-1', 'audit-1']);
});

test('invalid limits, scope and duplicate owners are rejected before starting a transaction', async () => {
  const db = { $transaction() { throw new Error('transaction must not start'); } };
  for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) {
    await assert.rejects(runPharmacyRetentionPurge(db, scope, [], limit), /limit must be/);
  }
  await assert.rejects(runPharmacyRetentionPurge(db, { organizationId: '' }, []), /explicit organization/);
  await assert.rejects(runPharmacyRetentionPurge(db, scope, [{ recordClass: 'AUDIT' }, { recordClass: 'AUDIT' }]), /one owner/);
});

test('oversized, duplicate and malformed owner pages are rejected without deleting', async () => {
  for (const ids of [['a', 'b'], ['a', 'a'], [''], [null]]) {
    const db = database();
    const adapter = { ...owner(db, []), async candidates() { return ids; } };
    await assert.rejects(runPharmacyRetentionPurge(db, scope, [adapter], ids.length === 2 && ids[1] === 'b' ? 1 : 2), /invalid or unbounded/);
    assert.deepEqual(db.deleted, []);
  }
});

test('savepoint restores preceding deletes even when an outer caller catches owner failure', async () => {
  const db = database();
  const adapter = owner(db, ['first', 'second']);
  const remove = adapter.deleteAggregate;
  adapter.deleteAggregate = async (...args) => {
    await remove(...args);
    if (args[2] === 'second') throw new Error('aggregate child refused deletion');
  };
  await assert.rejects(runPharmacyRetentionPurge(db, scope, [adapter]), /child refused/);
  assert.deepEqual(db.deleted, []);
  db.tx.$queryRaw = async () => { throw new Error('database unavailable'); };
  await assert.rejects(runPharmacyRetentionPurge(db, scope, [owner(db, ['first'])]), /database unavailable/);
});
