import { Client } from 'pg';

/**
 * Test cleanup: delete every row a DB test wrote for its own organizations, then
 * the organizations and (optionally) the platform medicine catalogues the test
 * loaded under its own keys. Nothing outside `organizationIds` / `catalogueKeys`
 * is touched.
 *
 * Runs as the table owner (`*_OWNER_DATABASE_URL`) in ONE transaction:
 *  - every base table with an "organizationId" column is emptied of the test's
 *    rows, children before parents (a delete refused by a foreign key is simply
 *    retried on the next pass);
 *  - append-only tables refuse a DELETE through their guard triggers. For those,
 *    and only those, user triggers are disabled with `ALTER TABLE … DISABLE
 *    TRIGGER USER` — transactional, so the guard is back the moment this commits
 *    or rolls back, and never visible to another session;
 *  - a cycle of required-looking references (a branch naming its default stock
 *    location, say) is broken by clearing the nullable foreign-key columns
 *    between the tables still left, as the tenant purge does.
 *
 * A `lock_timeout` bounds the wait for the owner-only ALTERs, so a busy shared
 * test database fails the cleanup loudly instead of hanging the run.
 */
export async function deleteTestOrganizations(
  ownerUrl: string,
  input: { organizationIds: readonly string[]; catalogueKeys?: readonly string[] }
): Promise<void> {
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '20s'`);
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const tables = (
      await client.query<{ table_name: string }>(
        `SELECT c.table_name
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public'
            AND c.column_name = 'organizationId'
            AND t.table_type = 'BASE TABLE'
          ORDER BY c.table_name`
      )
    ).rows.map((row) => row.table_name);
    const disabled = new Set<string>();

    const attempt = async (sql: string, params: unknown[]) => {
      await client.query('SAVEPOINT test_cleanup');
      try {
        await client.query(sql, params);
        await client.query('RELEASE SAVEPOINT test_cleanup');
        return null;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT test_cleanup');
        return (error as { code?: string }).code ?? 'UNKNOWN';
      }
    };

    for (const organizationId of input.organizationIds) {
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.purging_organization_id', $1, true)`,
        [organizationId]
      );
      let remaining: string[] = [];
      for (const table of tables) {
        const found = await client.query(
          `SELECT 1 FROM ${quote(table)} WHERE "organizationId" = $1 LIMIT 1`,
          [organizationId]
        );
        if (found.rowCount) remaining.push(table);
      }

      for (let pass = 0; remaining.length; pass += 1) {
        if (pass > 60) {
          throw new Error(`Test cleanup could not empty: ${remaining.join(', ')}`);
        }
        const left: string[] = [];
        for (const table of remaining) {
          const sql = `DELETE FROM ${quote(table)} WHERE "organizationId" = $1`;
          let code = await attempt(sql, [organizationId]);
          if (code && code !== '23503' && !disabled.has(table)) {
            // A guard trigger refused it: this table is append-only.
            await client.query(`ALTER TABLE ${quote(table)} DISABLE TRIGGER USER`);
            disabled.add(table);
            code = await attempt(sql, [organizationId]);
          }
          if (code) left.push(table);
        }
        if (left.length === remaining.length) {
          // No progress: clear the nullable references between what is left.
          const references = await client.query<{ table_name: string; column_name: string }>(
            `SELECT child.relname AS table_name, attribute.attname::text AS column_name
               FROM pg_constraint constraint_row
               JOIN pg_class child ON child.oid = constraint_row.conrelid
               JOIN pg_class parent ON parent.oid = constraint_row.confrelid
               JOIN LATERAL unnest(constraint_row.conkey) AS key(attnum) ON true
               JOIN pg_attribute attribute
                 ON attribute.attrelid = child.oid AND attribute.attnum = key.attnum
              WHERE constraint_row.contype = 'f'
                AND child.relnamespace = 'public'::regnamespace
                AND child.relname = ANY($1) AND parent.relname = ANY($1)
                AND NOT attribute.attnotnull`,
            [left]
          );
          for (const { table_name: table, column_name: column } of references.rows) {
            const sql = `UPDATE ${quote(table)} SET ${quote(column)} = NULL
                          WHERE "organizationId" = $1`;
            if ((await attempt(sql, [organizationId])) && !disabled.has(table)) {
              await client.query(`ALTER TABLE ${quote(table)} DISABLE TRIGGER USER`);
              disabled.add(table);
              await attempt(sql, [organizationId]);
            }
          }
          if (!references.rows.length) {
            throw new Error(`Test cleanup is stuck on: ${left.join(', ')}`);
          }
        }
        remaining = left;
      }
    }

    for (const table of disabled) {
      await client.query(`ALTER TABLE ${quote(table)} ENABLE TRIGGER USER`);
    }
    await client.query('DELETE FROM organizations WHERE id = ANY($1)', [
      [...input.organizationIds],
    ]);
    if (input.catalogueKeys?.length) {
      await client.query(
        `DELETE FROM platform_medicine_catalogue_items WHERE "versionId" IN
           (SELECT id FROM platform_medicine_catalogue_versions WHERE key = ANY($1))`,
        [[...input.catalogueKeys]]
      );
      await client.query('DELETE FROM platform_medicine_catalogue_versions WHERE key = ANY($1)', [
        [...input.catalogueKeys],
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
