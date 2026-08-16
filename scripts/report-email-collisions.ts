/**
 * Read-only companion to the D10 email-normalization migration.
 *
 * `20260802120000_user_email_lowercase` aborts when two rows in one organization
 * differ only by the case (or surrounding whitespace) of their email. It does not
 * merge, deactivate, or drop anything: two such rows may be one duplicate person
 * or two real people, and only a human can tell.
 *
 * Run this against the same database to get the report an operator needs in order
 * to resolve them by hand, then re-run the migration.
 *
 *   DATABASE_URL='postgresql://...' bun run report:email-collisions
 *
 * This script issues SELECT statements only.
 */
import pg from 'pg';

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

type CollisionRow = {
  organizationId: string;
  organizationSlug: string | null;
  normalized: string;
  userCount: string;
  ids: string[];
  emails: string[];
  statuses: string[];
  lastActive: Array<string | null>;
};

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<CollisionRow>(
      `SELECT
         u."organizationId",
         o."slug"                                     AS "organizationSlug",
         lower(btrim(u."email"))                      AS "normalized",
         count(*)                                     AS "userCount",
         array_agg(u."id"           ORDER BY u."createdAt") AS "ids",
         array_agg(u."email"        ORDER BY u."createdAt") AS "emails",
         array_agg(u."status"::text ORDER BY u."createdAt") AS "statuses",
         array_agg(to_char(u."lastActiveAt", 'YYYY-MM-DD') ORDER BY u."createdAt") AS "lastActive"
       FROM "users" u
       LEFT JOIN "organizations" o ON o."id" = u."organizationId"
       GROUP BY u."organizationId", o."slug", lower(btrim(u."email"))
       HAVING count(*) > 1
       ORDER BY u."organizationId", lower(btrim(u."email"))`
    );

    if (rows.length === 0) {
      console.log('No email case collisions. The normalization migration can be applied as-is.');
      return;
    }

    console.log(`${rows.length} email case collision(s) found.\n`);
    console.log('Resolve each one by hand before re-running the migration. Two rows differing');
    console.log(
      'only by case may be one duplicate or two real people — this tool never guesses.\n'
    );

    for (const row of rows) {
      console.log(
        `organization ${row.organizationId}${row.organizationSlug ? ` (${row.organizationSlug})` : ''}`
      );
      console.log(`  normalized address: ${row.normalized}`);
      for (let index = 0; index < row.ids.length; index += 1) {
        console.log(
          `    - id=${row.ids[index]} email=${JSON.stringify(row.emails[index])} ` +
            `status=${row.statuses[index]} lastActive=${row.lastActive[index] ?? 'never'}`
        );
      }
      console.log('');
    }

    // Non-zero exit so CI or a deploy step can gate on this without parsing output.
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
