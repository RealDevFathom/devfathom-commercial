// @vitest-environment node

import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const dispositionUrl = new URL(
  '../docs/archive-recovery/issue-494-rescue-wha-242.md',
  import.meta.url
);

describe('issue #494 archive recovery disposition', () => {
  it('records one unambiguous decision for the preserved archive', async () => {
    const disposition = await readFile(dispositionUrl, 'utf8');

    expect(disposition).toContain('archive/rescue/WHA-242');
    expect(disposition).toContain('close the archived branch as obsolete');
    expect(disposition).toContain('Do not restore `rescue/WHA-242` as a branch.');
    expect(disposition).toContain('Do not open a PR from `archive/rescue/WHA-242`.');
    expect(disposition).toContain('Do not cherry-pick any of the five commits.');
  });

  it.each(['a678e149', 'a24e10f0', '5b44fd62', '296440a2', 'd8696e47'])(
    'accounts for archived commit %s with a disposition',
    async (commit) => {
      const disposition = await readFile(dispositionUrl, 'utf8');

      expect(disposition).toContain(`| \`${commit}\` |`);
    }
  );

  it.each([
    ['scripts/seed-restaurant-e2e.ts', "slug: 'chai-chowk'"],
    ['src/lib/tenant-brand.ts', 'export function assertWorkspaceIdentity('],
    ['src/app/(app)/layout.tsx', 'assertWorkspaceIdentity('],
    ['src/lib/module-catalog.ts', 'export function evaluateSopDepth('],
    ['src/server/routers/restaurant-sop-execution.ts', 'evaluateSopDepth('],
    ['src/app/(app)/restaurant/sop/admin/sop-admin.tsx', "kind: 'exhausted'"],
    [
      'prisma/migrations/20260828140000_restaurant_promotions_core/migration.sql',
      'CREATE TABLE "restaurant_promotion_cap_counters"',
    ],
    ['src/lib/restaurant/promotion-evaluator.ts', 'export function evaluatePromotions('],
    ['src/lib/restaurant/promotion-caps.ts', 'export async function reserveCaps('],
  ])('keeps the superseding implementation in %s', async (path, marker) => {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');

    expect(source).toContain(marker);
  });

  it.each([
    'docs/admin-platform/adr/006-workspace-identity.md',
    'claude/decisions/sop-entitlement-model.md',
    'src/lib/restaurant/promotion-snapshot.ts',
    'src/server/routers/restaurant-promotions.ts',
    'src/lib/restaurant/promotion-caps.db.test.ts',
  ])('keeps referenced evidence file %s', async (path) => {
    await expect(access(new URL(`../${path}`, import.meta.url))).resolves.toBeUndefined();
  });
});
