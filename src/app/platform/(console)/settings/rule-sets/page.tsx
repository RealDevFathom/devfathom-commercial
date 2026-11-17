import { JurisdictionRuleSets } from '@/components/platform/jurisdiction-rule-sets';
import { SectionCard } from '@/components/ui/section-card';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

export default async function JurisdictionRuleSetsPage() {
  const actor = await requirePlatformRead('/platform/settings');
  if (actor.role !== 'SUPER_ADMIN') {
    return (
      <SectionCard title="SuperAdmin access required">
        Only a SuperAdmin can review and publish jurisdiction rules.
      </SectionCard>
    );
  }
  const ruleSets = await withPlatformDb((db) =>
    db.jurisdictionRuleSet.findMany({
      orderBy: [{ code: 'asc' }, { version: 'desc' }],
    })
  );
  return <JurisdictionRuleSets ruleSets={ruleSets} />;
}
