// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** DEV-293: the register's independent-witness check gives way only for a solo restoration. */
const url = process.env.CONTROLLED_TEST_DATABASE_URL ?? process.env.OWNER_DATABASE_URL;
const schema = `solo_witness_${randomUUID().replaceAll('-', '')}`;
const migration = readFileSync(
  'prisma/migrations/20261115093000_controlled_register_solo_self_witness/migration.sql',
  'utf8'
);

(url ? describe : describe.skip)('controlled register solo self-witness constraint', () => {
  const client = new Client({ connectionString: url });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE pharmacy_controlled_register_entries (
        id text PRIMARY KEY, "entryKind" text NOT NULL, "restorationMovementId" text,
        "signatureRef" text, "recordedByUserId" text NOT NULL, "witnessedByUserId" text NOT NULL,
        CHECK ("recordedByUserId" <> "witnessedByUserId"));`);
    await client.query(migration);
    // Idempotent: a second run changes nothing and does not fail.
    await client.query(migration);
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  function insert(row: {
    entryKind: string;
    restorationMovementId: string | null;
    signatureRef: string | null;
    witness: string;
  }) {
    return client.query(
      `INSERT INTO pharmacy_controlled_register_entries VALUES ($1,$2,$3,$4,'pharmacist',$5)`,
      [randomUUID(), row.entryKind, row.restorationMovementId, row.signatureRef, row.witness]
    );
  }

  it('replaces the unnamed legacy check with one named constraint', async () => {
    const result = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='pharmacy_controlled_register_entries'::regclass AND contype='c'`
    );
    expect(result.rows.map((row) => row.conname)).toEqual([
      'pharmacy_controlled_register_independent_witness',
    ]);
  });

  it('accepts a solo PIN-signed restoration', async () => {
    await expect(
      insert({
        entryKind: 'CORRECTION',
        restorationMovementId: 'reversal',
        signatureRef: 'solo-pin:credential:nonce',
        witness: 'pharmacist',
      })
    ).resolves.toBeTruthy();
  });

  it.each([
    ['a sale', 'SALE', 'movement', 'solo-pin:credential:nonce'],
    ['a manual correction', 'CORRECTION', null, 'solo-pin:credential:nonce'],
    ['an ordinary PIN signature', 'CORRECTION', 'reversal', 'pin:credential:nonce'],
    ['no signature', 'CORRECTION', 'reversal', null],
  ])('still rejects self-witnessing for %s', async (_label, entryKind, movement, signature) => {
    await expect(
      insert({
        entryKind,
        restorationMovementId: movement,
        signatureRef: signature,
        witness: 'pharmacist',
      })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps accepting an independent witness', async () => {
    await expect(
      insert({
        entryKind: 'SALE',
        restorationMovementId: null,
        signatureRef: 'pin:other',
        witness: 'second-pharmacist',
      })
    ).resolves.toBeTruthy();
  });
});
