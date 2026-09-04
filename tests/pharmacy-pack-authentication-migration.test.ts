import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260905040000_pharmacy_pack_authentication/migration.sql',
  'utf8'
);

describe('WHA-1336 pack authentication storage contract', () => {
  it('forces tenant and branch RLS on both tables', () => {
    expect(migration).toContain(
      "FOREACH t IN ARRAY ARRAY['pharmacy_pack_authentication_scans','pharmacy_pack_authentication_events']"
    );
    expect(migration).toContain('ALTER TABLE %I ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
  });

  it('keeps scan evidence undeletable and event history append-only', () => {
    expect(migration).toContain('pharmacy_pack_authentication_events_append_only');
    expect(migration).toContain('pharmacy_pack_authentication_scans_no_delete');
  });

  it('makes recall the only authentication status tied to a block', () => {
    expect(migration).toContain(
      '("status"=\'BLOCKED_RECALL\')=("issues" @> ARRAY[\'RECALLED_BATCH\']::TEXT[])'
    );
    expect(migration).not.toMatch(/counterfeit/i);
    expect(migration).not.toMatch(/external.*(authority|report)/i);
  });
});
