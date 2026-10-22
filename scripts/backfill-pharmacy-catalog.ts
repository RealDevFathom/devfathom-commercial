import { backfillPharmacyCatalog } from '../src/lib/pharmacy/catalog/backfill';
import { withPlatformDb } from '../src/lib/tenancy/scoped-db';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (apply === args.includes('--dry-run'))
  throw new Error('Choose exactly one of --dry-run or --apply.');
const orgAt = args.indexOf('--org');
const allPharmacy = args.includes('--all-pharmacy');
if (orgAt >= 0 === allPharmacy || (orgAt >= 0 && !args[orgAt + 1]))
  throw new Error('Choose exactly one of --org <id> or --all-pharmacy.');
const actorId = process.env.PLATFORM_ACTOR_ID;
if (!actorId) throw new Error('PLATFORM_ACTOR_ID is required.');
const actor = await withPlatformDb((db) =>
  db.platformUser.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, active: true },
  })
);
if (!actor) throw new Error('Platform actor not found.');
// The service authorizes this actor through the central can() decision.
const result = await backfillPharmacyCatalog(
  actor,
  allPharmacy ? { allPharmacy: true } : { organizationId: args[orgAt + 1]! },
  apply
);
// Counts and identifiers only. Catalogue item contents must never be logged.
console.log(JSON.stringify(result));
