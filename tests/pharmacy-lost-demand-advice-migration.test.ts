import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20261117200512_pharmacy_lost_demand_advice/migration.sql'
  ),
  'utf8'
);

describe('DEV-80 lost-demand advice migration contract', () => {
  it('is one transaction', () => {
    expect(migration.trimStart()).toMatch(/^(--[^\n]*\n)*BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('enables and forces row-level security on both tenant tables', () => {
    expect(migration).toContain(
      "ARRAY['pharmacy_lost_demand_trigger_settings','pharmacy_lost_demand_advice_decisions']"
    );
    expect(migration).toContain("'ALTER TABLE %I ENABLE ROW LEVEL SECURITY'");
    expect(migration).toContain("'ALTER TABLE %I FORCE ROW LEVEL SECURITY'");
  });

  it('keeps decisions append-only but lets the tenant purge remove its own rows', () => {
    expect(migration).toMatch(
      /BEFORE UPDATE OR DELETE ON "pharmacy_lost_demand_advice_decisions"\s+FOR EACH ROW EXECUTE FUNCTION pharmacy_lost_demand_decisions_append_only\(\);/
    );
    // A delete passes only for the tenant the purge names, or once the tenant is gone.
    // ...and only inside the platform control plane's purge transaction, never a
    // tenant transaction that names its own organization.
    expect(migration).toContain(
      `IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN`
    );
    expect(migration).toContain(
      `IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN`
    );
    // UPDATE never has an exit: the only RETURN statements sit inside the DELETE branch.
    const body = migration.slice(
      migration.indexOf('pharmacy_lost_demand_decisions_append_only() RETURNS trigger'),
      migration.indexOf('END $$;')
    );
    const deleteBranch = body.slice(
      body.indexOf("IF TG_OP = 'DELETE' THEN"),
      body.lastIndexOf('END IF;')
    );
    expect(body.match(/RETURN OLD;/g)).toHaveLength(2);
    expect(deleteBranch.match(/RETURN OLD;/g)).toHaveLength(2);
    expect(body.trimEnd()).toMatch(/RAISE EXCEPTION '% is append-only'[^;]*;$/);
  });
});
