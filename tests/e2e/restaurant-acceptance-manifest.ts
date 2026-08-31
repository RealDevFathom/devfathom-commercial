import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export type CoverageStatus =
  'Delivered' | 'Needs browser acceptance' | 'Partial' | 'Unbuilt' | 'External';

type EvidenceKind = 'route' | 'source' | 'test';

export interface EvidenceReference {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly path: string;
}

export interface CoverageEntry {
  readonly id: string;
  readonly requirement: string;
  readonly status: CoverageStatus;
  readonly evidence: readonly EvidenceReference[];
  readonly boundary: string;
}

export interface ActorEntry {
  readonly id: string;
  readonly actor: string;
  readonly allowedProof: string;
  readonly deniedProof: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface ActiveLaneOwnership {
  readonly issue: string;
  readonly ownedSurface: string;
  readonly forbiddenEvidencePathPatterns: readonly string[];
}

const route = (id: string, path: string): EvidenceReference => ({
  id,
  kind: 'route',
  path,
});
const source = (id: string, path: string): EvidenceReference => ({
  id,
  kind: 'source',
  path,
});
const test = (id: string, path: string): EvidenceReference => ({
  id,
  kind: 'test',
  path,
});

export const activeLaneOwnership = [
  {
    issue: 'WHA-228',
    ownedSurface: 'physical printing implementation and golden-byte fixtures',
    forbiddenEvidencePathPatterns: ['^src/lib/restaurant/printing/'],
  },
  {
    issue: 'WHA-281',
    ownedSurface: 'promotion money, loyalty, and insight integration',
    forbiddenEvidencePathPatterns: [
      'promotion[^/]*(money|loyalty|insight)',
      '(money|loyalty|insight)[^/]*promotion',
    ],
  },
  {
    issue: 'WHA-282',
    ownedSurface: 'promotion offline parity and admin console',
    forbiddenEvidencePathPatterns: [
      'promotion[^/]*(offline|admin)',
      '(offline|admin)[^/]*promotion',
    ],
  },
  {
    issue: 'WHA-286',
    ownedSurface: 'role-profile provenance UI',
    forbiddenEvidencePathPatterns: ['role[-_/]?profile', 'profile[-_/]?provenance'],
  },
  {
    issue: 'WHA-297',
    ownedSurface: 'terminal-payment integration verification',
    forbiddenEvidencePathPatterns: ['terminal[-_/]?payments?', 'payments?[-_/]?terminal'],
  },
  {
    issue: 'WHA-298',
    ownedSurface: 'wallet passes',
    forbiddenEvidencePathPatterns: ['(^|/)wallet([-/_.]|$)'],
  },
  {
    issue: 'WHA-299',
    ownedSurface: 'restaurant guide',
    forbiddenEvidencePathPatterns: ['restaurant[^/]*guide', 'guide[^/]*restaurant'],
  },
  {
    issue: 'WHA-300',
    ownedSurface: 'friendly branch/operator selectors',
    forbiddenEvidencePathPatterns: ['friendly[-_/]?selector', '(branch|operator)[-_/]?selector'],
  },
] as const satisfies readonly ActiveLaneOwnership[];

export const coverageMatrix = [
  {
    id: 'vertical-foundation',
    requirement: 'Vertical-aware platform, packages, onboarding, default branch, activation',
    status: 'Delivered',
    evidence: [
      source('vertical-schema', 'prisma/schema.prisma'),
      source('vertical-catalog', 'src/lib/vertical-catalog.ts'),
      test('vertical-foundation-tests', 'tests/vertical-foundation.test.ts'),
    ],
    boundary: 'Production bootstrap/deployment is not claimed.',
  },
  {
    id: 'restaurant-core',
    requirement: 'Restaurant Core: branches, staff, jobs, devices, operator credentials, sessions',
    status: 'Needs browser acceptance',
    evidence: [
      source('restaurant-staff-router', 'src/server/routers/restaurant-staff.ts'),
      source('restaurant-jobs-router', 'src/server/routers/restaurant-jobs.ts'),
      source('restaurant-devices-router', 'src/server/routers/restaurant-devices.ts'),
      route('restaurant-staff-route', 'src/app/(app)/restaurant/staff/page.tsx'),
      route('restaurant-roster-route', 'src/app/(app)/restaurant/staff/roster/page.tsx'),
      route('restaurant-devices-route', 'src/app/(app)/restaurant/devices/page.tsx'),
      test('restaurant-m2-contract', 'tests/restaurant-m2-contract.test.ts'),
      test('restaurant-m2-rls', 'tests/restaurant-m2-rls.test.ts'),
    ],
    boundary: 'Friendly selectors are WHA-300; role-profile provenance UI is WHA-286.',
  },
  {
    id: 'tax-and-numbering',
    requirement: 'Tax, service charge, business date, numbering',
    status: 'Delivered',
    evidence: [
      source('tax-calculator', 'src/lib/restaurant/tax-calculator.ts'),
      source('tax-contracts', 'src/lib/restaurant/tax-contracts.ts'),
      source('order-numbers', 'src/lib/restaurant/order-numbers.ts'),
      test('tax-core-rls', 'tests/restaurant-tax-core-rls.test.ts'),
    ],
    boundary: 'Jurisdiction and fiscalization policy remain External under D02/D15.',
  },
  {
    id: 'pos-kds',
    requirement: 'POS orders, floor, table, item/course lifecycle, KDS',
    status: 'Needs browser acceptance',
    evidence: [
      route('pos-route', 'src/app/(terminal)/pos/page.tsx'),
      route('kds-route', 'src/app/(terminal)/kds/page.tsx'),
      route('orders-open-api', 'src/app/api/restaurant/orders/open/route.ts'),
      route('kds-queue-api', 'src/app/api/restaurant/kds/queue/route.ts'),
      test('m4-acceptance', 'tests/restaurant-m4-acceptance.test.ts'),
      test('m4-kitchen-flow', 'tests/restaurant-m4-kitchen-flow.test.ts'),
      test('pos-kds-browser', 'tests/e2e/restaurant-pos-kds.spec.ts'),
    ],
    boundary: 'Fixture browser proof is not final four-actor, tablet, or hardware acceptance.',
  },
  {
    id: 'bills-and-close',
    requirement: 'Bills, split tender, cash drawers, daily close, refunds/voids',
    status: 'Delivered',
    evidence: [
      route('checkout-tender-api', 'src/app/api/restaurant/checkout/tender/route.ts'),
      route('checkout-refund-api', 'src/app/api/restaurant/checkout/refund/route.ts'),
      route('cash-day-close-api', 'src/app/api/restaurant/cash/day/close/route.ts'),
      test('m5-acceptance', 'tests/restaurant-m5-acceptance.test.ts'),
    ],
    boundary:
      'WHA-297 owns terminal review; processor/card-device selection remains External under D03.',
  },
  {
    id: 'menu-catalog',
    requirement:
      'Menu, brands, catalog, recipes, modifiers, combos, price lists, publication/dayparts',
    status: 'Delivered',
    evidence: [
      source('catalog-router', 'src/server/routers/restaurant-catalog.ts'),
      source('menus-router', 'src/server/routers/restaurant-menus.ts'),
      route('catalog-route', 'src/app/(app)/restaurant/catalog/page.tsx'),
      route('menus-route', 'src/app/(app)/restaurant/menus/page.tsx'),
      test('m3-acceptance', 'tests/restaurant-m3-acceptance.test.ts'),
      test('m3-publication', 'tests/restaurant-m3-publication-availability.test.ts'),
    ],
    boundary: 'RTL visual/device proof is not established; OCR import is a separate adjunct.',
  },
  {
    id: 'inventory-purchasing',
    requirement: 'Inventory and purchasing',
    status: 'Needs browser acceptance',
    evidence: [
      source('inventory-router', 'src/server/routers/restaurant-inventory.ts'),
      source('purchasing-router', 'src/server/routers/restaurant-purchasing.ts'),
      route('inventory-route', 'src/app/(app)/restaurant/inventory/page.tsx'),
      route('purchasing-route', 'src/app/(app)/restaurant/purchasing/page.tsx'),
      test('m6-acceptance', 'tests/restaurant-m6-acceptance.test.ts'),
    ],
    boundary: 'Final admin/reconciliation browser proof remains; policy D07 is External.',
  },
  {
    id: 'workforce',
    requirement: 'Workforce scheduling and attendance',
    status: 'Needs browser acceptance',
    evidence: [
      source('workforce-source', 'src/lib/restaurant/workforce.ts'),
      source('shifts-router', 'src/server/routers/restaurant-shifts.ts'),
      source(
        'workforce-migration',
        'prisma/migrations/20260830180000_restaurant_workforce_v1/migration.sql'
      ),
      test('workforce-unit', 'src/lib/restaurant/workforce.test.ts'),
      test('workforce-routing', 'tests/restaurant-workforce-routing.test.ts'),
      test('workforce-migration-test', 'tests/restaurant-workforce-migration.test.ts'),
      test('shifts-rls', 'tests/restaurant-shifts-rls.test.ts'),
    ],
    boundary:
      'Clock in/out, breaks, swap request/review, late attendance, append-only corrections, and CSV export are implemented; browser/release acceptance remains, while payroll and tip payout are deferred.',
  },
  {
    id: 'sop-jobs-notifications',
    requirement: 'SOP, recurrence, evidence, verification, escalation, notifications',
    status: 'Partial',
    evidence: [
      source('notifications-source', 'src/lib/restaurant/notifications.ts'),
      source('sop-escalation-source', 'src/lib/restaurant/sop-escalation.ts'),
      source('webhook-inbox-source', 'src/lib/restaurant/webhook-inbox.ts'),
      route('sop-route', 'src/app/(app)/restaurant/sop/page.tsx'),
      route('notifications-route', 'src/app/(app)/restaurant/notifications/page.tsx'),
      test('m7-acceptance', 'tests/restaurant-m7-acceptance.test.ts'),
    ],
    boundary:
      'Email/SMS/push/WhatsApp and signature verification are stubbed; provider choice is External under D21.',
  },
  {
    id: 'customers-loyalty',
    requirement: 'Customers, consent, loyalty, visit/order history',
    status: 'Needs browser acceptance',
    evidence: [
      source('customers-router', 'src/server/routers/restaurant-customers.ts'),
      source('loyalty-router', 'src/server/routers/restaurant-loyalty.ts'),
      route('loyalty-route', 'src/app/(app)/restaurant/loyalty/page.tsx'),
      test('m8-acceptance', 'tests/restaurant-m8-acceptance.test.ts'),
      test('m8-rls', 'tests/restaurant-m8-rls.test.ts'),
    ],
    boundary: 'Wallet passes are WHA-298; final browser acceptance and D08 policy remain.',
  },
  {
    id: 'insights',
    requirement: 'Insights, item mix, liability, restricted labour cost',
    status: 'Needs browser acceptance',
    evidence: [
      source('insights-router', 'src/server/routers/restaurant-insights.ts'),
      route('insights-route', 'src/app/(app)/restaurant/insights/page.tsx'),
      test('m8-governance', 'tests/restaurant-m8-governance.test.ts'),
      test('insights-router-tests', 'src/server/routers/restaurant-insights.test.ts'),
    ],
    boundary:
      'Metric/freshness/rebuild policy is External under D22; reconciliation/browser proof remains.',
  },
  {
    id: 'promotions',
    requirement: 'Promotions',
    status: 'Partial',
    evidence: [
      source('promotion-evaluator', 'src/lib/restaurant/promotion-evaluator.ts'),
      source('promotion-snapshot', 'src/lib/restaurant/promotion-snapshot.ts'),
      source('promotion-schedule', 'src/lib/restaurant/promotion-schedule.ts'),
      test('promotion-evaluator-tests', 'src/lib/restaurant/promotion-evaluator.test.ts'),
    ],
    boundary:
      'Money/loyalty/insight integration is WHA-281; offline parity/admin console is WHA-282.',
  },
  {
    id: 'integrations-devices',
    requirement: 'Integrations, cameras, terminal devices, webhooks',
    status: 'Partial',
    evidence: [
      route('camera-route', 'src/app/(app)/restaurant/integrations/cameras/page.tsx'),
      route('camera-stream-api', 'src/app/api/restaurant/cameras/[cameraId]/stream/route.ts'),
      route('webhook-api', 'src/app/api/restaurant/webhooks/[source]/route.ts'),
      test('camera-stream-tests', 'src/app/api/restaurant/cameras/[cameraId]/stream/route.test.ts'),
    ],
    boundary:
      'Provider signatures/non-in-app delivery remain stubbed; terminal review is WHA-297; D03/D05/D21 are External.',
  },
  {
    id: 'physical-printing',
    requirement: 'Physical printing',
    status: 'Unbuilt',
    evidence: [],
    boundary: 'No canonical implementation or golden-byte fixtures; entire lane is WHA-228.',
  },
  {
    id: 'offline-pos-kds',
    requirement: 'Offline POS/KDS',
    status: 'Needs browser acceptance',
    evidence: [
      source('pos-client-store', 'src/lib/restaurant/pos-client-store.ts'),
      source('pos-command-queue', 'src/lib/restaurant/pos-command-queue.ts'),
      test('pos-kds-resilience', 'tests/e2e/restaurant-pos-kds-resilience.spec.ts'),
    ],
    boundary:
      'Accepted offline promise/latency target is External under D04; promotion parity is WHA-282.',
  },
  {
    id: 'localization-accessibility',
    requirement: 'Localization/RTL and accessibility',
    status: 'Partial',
    evidence: [
      test('pos-kds-accessibility', 'tests/e2e/restaurant-pos-kds-accessibility.spec.ts'),
      test('catalog-localization-roundtrip', 'src/server/routers/restaurant-catalog.test.ts'),
    ],
    boundary:
      'Pilot language matrix and tablet/RTL proof remain External/acceptance work under D20.',
  },
  {
    id: 'deferred-product-scope',
    requirement:
      'Reservations/waitlist, gift/stored value, native mobile, payroll, full driver logistics',
    status: 'External',
    evidence: [],
    boundary: 'Excluded unless a human approves scope and commercial case.',
  },
] as const satisfies readonly CoverageEntry[];

export const externalBoundaries = [
  {
    id: 'human-decisions',
    status: 'External',
    requirement: 'D02/D03/D04/D05/D07/D08/D20/D21/D22',
    boundary:
      'No launch claim may infer these jurisdiction, vendor, SLA, hardware, policy, localization, provider, or analytics decisions.',
  },
] as const;

export const finalActorMatrix = [
  {
    id: 'super-admin',
    actor: 'SuperAdmin',
    allowedProof:
      'Create and preflight-activate a compatible Restaurant with default branch/admin/templates; inspect tenant.',
    deniedProof: 'Reject Agency package and active vertical change; preserve ordinary tenant RLS.',
    evidence: [
      test(
        'platform-new-organization-tests',
        'src/app/platform/(console)/organizations/new/page.test.tsx'
      ),
      route(
        'platform-new-organization-route',
        'src/app/platform/(console)/organizations/new/page.tsx'
      ),
    ],
  },
  {
    id: 'agency',
    actor: 'Agency',
    allowedProof: 'Existing agency dashboard/modules remain usable.',
    deniedProof:
      'Deny Restaurant package/module/routes/procedures/API and tenant data; preserve agency records.',
    evidence: [
      test('agency-onboarding-regression', 'tests/agency-onboarding-regression.test.ts'),
      route('agency-dashboard-route', 'src/app/(app)/dashboard/page.tsx'),
    ],
  },
  {
    id: 'restaurant-admin-operator',
    actor: 'Restaurant admin/operator',
    allowedProof:
      'Admin configures named domains; operator signs in and completes drawer/order/KDS/tender/refund/close flow.',
    deniedProof:
      'Wrong branch, inactive operator, missing capability/module, locked/revoked terminal, cross-day mutation, and replay fail closed.',
    evidence: [
      test('terminal-threats', 'tests/restaurant-m2-terminal-threats.test.ts'),
      route('terminal-establish-api', 'src/app/api/restaurant/terminal/establish/route.ts'),
    ],
  },
  {
    id: 'cross-vertical-tenant',
    actor: 'Cross-vertical and cross-tenant',
    allowedProof:
      'Same-host Agency and Restaurant sessions use their own surfaces; permitted Restaurant A data remains visible.',
    deniedProof:
      'Agency/Restaurant and Restaurant A/B isolation; branch scope; explicit consolidated-insight capability.',
    evidence: [
      test('shared-host-login', 'tests/e2e/shared-host-login.spec.ts'),
      test('m4-rls', 'tests/restaurant-m4-rls.test.ts'),
    ],
  },
] as const satisfies readonly ActorEntry[];

export const restaurantAcceptanceManifest = {
  planObject: '96377eb58282232683f28a3a355cd1baa4f955b8:claude/restaurant-completion-plan.md',
  baseCommit: '27b4e51165428e00248edc12d1b6e175f31933a6',
  coverageMatrix,
  externalBoundaries,
  finalActorMatrix,
  activeLaneOwnership,
} as const;

const repositoryRoot = process.cwd();

export function validateRestaurantAcceptanceManifest(root = repositoryRoot): readonly string[] {
  const errors: string[] = [];
  const ownerByEvidencePath = new Map<string, string>();
  const allEntries: readonly (CoverageEntry | ActorEntry)[] = [
    ...coverageMatrix,
    ...finalActorMatrix,
  ];

  if (coverageMatrix.length !== 17) {
    errors.push(`Expected 17 code-grounded coverage rows, found ${coverageMatrix.length}.`);
  }
  if (finalActorMatrix.length !== 4) {
    errors.push(`Expected 4 final actor rows, found ${finalActorMatrix.length}.`);
  }
  if (!externalBoundaries.some((boundary) => boundary.status === 'External')) {
    errors.push('External boundaries must remain explicit.');
  }
  if (!coverageMatrix.some((entry) => entry.status === 'Partial')) {
    errors.push('Partial coverage must remain explicit.');
  }

  for (const entry of allEntries) {
    if (
      entry.evidence.length === 0 &&
      !('status' in entry && (entry.status === 'Unbuilt' || entry.status === 'External'))
    ) {
      errors.push(`${entry.id} has no evidence references.`);
    }

    for (const evidence of entry.evidence) {
      const normalizedPath = evidence.path.replaceAll('\\', '/');
      if (normalizedPath.startsWith('/') || normalizedPath.includes('..')) {
        errors.push(`${entry.id} has non-repository evidence path ${evidence.path}.`);
        continue;
      }
      if (!existsSync(resolve(root, normalizedPath))) {
        errors.push(`${entry.id} references missing file ${normalizedPath}.`);
      }

      const existingOwner = ownerByEvidencePath.get(normalizedPath);
      if (existingOwner) {
        errors.push(
          `Duplicate evidence ownership for ${normalizedPath}: ${existingOwner} and ${entry.id}.`
        );
      } else {
        ownerByEvidencePath.set(normalizedPath, entry.id);
      }

      for (const lane of activeLaneOwnership) {
        if (
          lane.forbiddenEvidencePathPatterns.some((pattern) =>
            new RegExp(pattern, 'i').test(normalizedPath)
          )
        ) {
          errors.push(
            `${entry.id} references ${normalizedPath}, owned by active lane ${lane.issue}.`
          );
        }
      }
    }
  }

  const lanePatternOwners = new Map<string, string>();
  for (const lane of activeLaneOwnership) {
    for (const pattern of lane.forbiddenEvidencePathPatterns) {
      const existingOwner = lanePatternOwners.get(pattern);
      if (existingOwner) {
        errors.push(
          `Duplicate active-lane ownership pattern ${pattern}: ${existingOwner} and ${lane.issue}.`
        );
      } else {
        lanePatternOwners.set(pattern, lane.issue);
      }
    }
  }

  return errors;
}

function runValidator(): void {
  const errors = validateRestaurantAcceptanceManifest();
  if (errors.length > 0) {
    console.error('Restaurant acceptance manifest invalid:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Restaurant acceptance manifest valid: ${coverageMatrix.length} coverage rows, ${finalActorMatrix.length} actor rows, ${activeLaneOwnership.length} active-lane boundaries.`
  );
}

if (process.argv[1] && basename(process.argv[1]) === 'restaurant-acceptance-manifest.ts') {
  runValidator();
}

export const manifestPathFromRepositoryRoot = 'tests/e2e/restaurant-acceptance-manifest.ts';
