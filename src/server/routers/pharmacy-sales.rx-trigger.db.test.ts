import { describe, expect, it } from 'vitest';

// Real PostgreSQL coverage for the fill trigger shipped in
// 20261021180100_pharmacy_rx_fill_release (#234). The trigger function is read
// straight from the migration file and installed on throwaway tables, so this
// asserts the ACTUAL migrated SQL — not a mock of $queryRaw — agrees with the
// application rule: allowance = authorizedCanonicalUnits * (authorizedRepeats +
// 1), voided sales release their fill, returned units subtract, and a fill past
// the allowance fails closed with a clear 23514.
describe.skipIf(!process.env.RX_GATE_DATABASE_URL)('Rx fill trigger (PostgreSQL)', () => {
  it('enforces the allowance, passes the exact boundary, and releases voids/returns', async () => {
    const { Client } = await import('pg');
    const { randomUUID } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const triggerSql = readFileSync(
      path.join(
        process.cwd(),
        'prisma/migrations/20261021180100_pharmacy_rx_fill_release/migration.sql'
      ),
      'utf8'
    );
    const schema = `rxt_${randomUUID().replaceAll('-', '')}`;
    const client = new Client({ connectionString: process.env.RX_GATE_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
        CREATE TABLE pharmacy_prescriptions (id text, "organizationId" text, "authorizedRepeats" int);
        CREATE TABLE pharmacy_prescription_lines (id text, "organizationId" text, "prescriptionId" text, "authorizedCanonicalUnits" int);
        CREATE TABLE pharmacy_sales (id text, "organizationId" text, status text);
        CREATE TABLE pharmacy_sale_lines (id text, "organizationId" text, "saleId" text);
        CREATE TABLE pharmacy_sale_return_lines ("organizationId" text, "saleLineId" text, "canonicalUnits" int);
        CREATE TABLE pharmacy_prescription_fills ("organizationId" text, "prescriptionLineId" text, "fillSequence" int, "quantityCanonicalUnits" int, "idempotencyKey" text, UNIQUE ("organizationId","prescriptionLineId","fillSequence"));
        INSERT INTO pharmacy_prescriptions VALUES ('rx-1','org-1',1);
        INSERT INTO pharmacy_prescription_lines VALUES ('line-1','org-1','rx-1',10);`);
      // Install the real migrated trigger function, then attach the trigger.
      await client.query(triggerSql);
      await client.query(
        `CREATE TRIGGER pharmacy_prescription_fill_remaining BEFORE INSERT ON pharmacy_prescription_fills FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_assert_fill_remaining()`
      );

      let seq = 0;
      // Each fill gets its own sale + sale line so sales can be voided and lines
      // returned independently — exactly the shape the real app writes.
      async function fill(key: string, units: number) {
        const saleId = `s-${key}`;
        const saleLineId = `sl-${key}`;
        await client.query(`INSERT INTO pharmacy_sales VALUES ($1,'org-1','OPEN')`, [saleId]);
        await client.query(`INSERT INTO pharmacy_sale_lines VALUES ($1,'org-1',$2)`, [
          saleLineId,
          saleId,
        ]);
        await client.query(
          `INSERT INTO pharmacy_prescription_fills VALUES ('org-1','line-1',$1,$2,$3)`,
          [++seq, units, `rx:${saleLineId}`]
        );
      }

      // allowance = 10 * (1 + 1) = 20.
      await fill('a', 10); // used 0 -> 10, ok
      await fill('b', 10); // used 10 -> 20, exact boundary passes (no off-by-one)
      await expect(fill('c', 1)).rejects.toThrow('fill exceeds remaining authorized quantity'); // used 20 + 1 > 20

      // A voided sale releases its fill entirely.
      await client.query(`UPDATE pharmacy_sales SET status='VOID' WHERE id='s-a'`);
      await fill('d', 10); // used 10 (a voided) + 10 <= 20, ok

      // Returned units subtract.
      await client.query(`INSERT INTO pharmacy_sale_return_lines VALUES ('org-1','sl-b',10)`);
      await fill('e', 10); // used = 0(a void) + 0(b returned) + 10(d) + 10 = 20, ok

      // An unknown prescription line fails closed.
      await expect(
        client.query(
          `INSERT INTO pharmacy_prescription_fills VALUES ('org-1','missing',1,1,'rx:none')`
        )
      ).rejects.toThrow('prescription line is unavailable');

      const total = (
        await client.query(
          `SELECT COALESCE(SUM("quantityCanonicalUnits"),0)::int AS u FROM pharmacy_prescription_fills`
        )
      ).rows[0].u;
      expect(total).toBe(40); // a,b,d,e recorded (immutable); allowance enforced on live units
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  }, 20_000);
});
