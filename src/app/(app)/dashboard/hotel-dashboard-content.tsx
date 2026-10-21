import Link from 'next/link';
import { Building2, Clock3, ListChecks, Tags } from 'lucide-react';

import { ReadinessChecklist } from '@/components/onboarding/readiness-checklist';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  summarizeHotelLanding,
  type HotelLanding,
  type HotelLandingProperty,
} from '@/lib/hotel/landing';

/**
 * H1 — the hospitality landing page.
 *
 * A HOSPITALITY workspace has no revenue, projects, tasks or invoices to show,
 * and its operating surfaces (reservations, folios) arrive with later lanes.
 * What exists today is the property onboarding walk, the property list and the
 * configuration pages, so the landing is built from exactly those, in the
 * Studio dashboard order: header → KPI ledger → the setup walk as the decision
 * panel → the property list and next steps as the watch list. Every state
 * (no access, no property, load failure) says what happened and what to do.
 */
export function HotelDashboardContent({
  landing,
  organizationName,
  isAdmin,
}: {
  landing: HotelLanding;
  organizationName: string;
  isAdmin: boolean;
}) {
  const properties = landing.kind === 'properties' ? landing.properties : [];
  const summary = summarizeHotelLanding(properties);
  const propertyHref =
    properties.length === 1
      ? `/hotel/settings/property?branchId=${encodeURIComponent(properties[0]!.branchId)}`
      : '/hotel/settings/property';
  const extrasHref =
    properties.length === 1
      ? `/hotel/settings/extras?branchId=${encodeURIComponent(properties[0]!.branchId)}`
      : '/hotel/settings/extras';
  // Offered only where a property sells rooms, beds or units: a venue's walk asks
  // for a function space instead, and its rooms page could add nothing.
  const roomSellers = properties.filter((property) => property.sellsRooms);
  const roomsHref =
    roomSellers.length === 0
      ? null
      : roomSellers.length === 1
        ? `/hotel/settings/rooms?branchId=${encodeURIComponent(roomSellers[0]!.branchId)}`
        : '/hotel/settings/rooms';
  // Meal plans are board sold with a stay, so they are offered where rooms are:
  // a venue sells no rooms and keeps its function-space step instead.
  const mealPlansHref =
    roomSellers.length === 0
      ? null
      : roomSellers.length === 1
        ? `/hotel/settings/meal-plans?branchId=${encodeURIComponent(roomSellers[0]!.branchId)}`
        : '/hotel/settings/meal-plans';
  // Offered only when a property's own configuration sells function space; the
  // page re-checks the module and the configuration on every read.
  const venues = properties.filter((property) => property.sellsFunctionSpaces);
  const spacesHref =
    venues.length === 0
      ? null
      : venues.length === 1
        ? `/hotel/settings/spaces?branchId=${encodeURIComponent(venues[0]!.branchId)}`
        : '/hotel/settings/spaces';

  return (
    <div className="space-y-6" data-testid="hotel-dashboard">
      <PageHeader
        eyebrow="Hospitality"
        heading={organizationName}
        description={
          landing.kind === 'properties'
            ? summary.ready
              ? 'Every property can be activated. Reservations and folios arrive with the operating modules.'
              : 'Property setup, where each property stands, and what to do next. Reservations and folios arrive with the operating modules.'
            : 'Property setup lives here once a property is assigned to you.'
        }
        actions={
          landing.kind === 'properties' ? (
            <>
              <Link
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
                href={propertyHref}
              >
                Property settings
              </Link>
              {roomsHref ? (
                <Link
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                  href={roomsHref}
                >
                  Rooms
                </Link>
              ) : spacesHref ? (
                <Link
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                  href={spacesHref}
                >
                  Function spaces
                </Link>
              ) : null}
              <Link className={buttonVariants({ size: 'lg' })} href={extrasHref}>
                Extras catalog
              </Link>
            </>
          ) : null
        }
      />

      {landing.kind === 'properties' ? (
        <>
          <section aria-label="Property setup at a glance">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
              <Kpi
                icon={Building2}
                label="Properties"
                value={summary.propertyCount}
                sub="Assigned to you"
              />
              <Kpi
                icon={ListChecks}
                label="Setup steps done"
                value={`${summary.stepsDone}/${summary.stepsTotal}`}
                sub="Recomputed from property data on every visit"
              />
              <Kpi
                icon={Clock3}
                label="Steps blocking go-live"
                value={summary.blockingSteps}
                sub={
                  summary.blockingSteps === 0
                    ? 'Nothing refuses activation'
                    : 'Each step is listed below with its fix'
                }
              />
              <Kpi
                icon={Tags}
                label="Extras in catalog"
                value={summary.extrasCount}
                sub="Active items every folio charge will name"
              />
            </div>
          </section>

          {properties.map((property) => (
            <PropertySetup key={property.branchId} property={property} />
          ))}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <SectionCard eyebrow="Properties" title="Your properties" titleLevel={2}>
              <ul className="divide-y divide-border-subtle">
                {properties.map((property) => (
                  <PropertyRow key={property.branchId} property={property} />
                ))}
              </ul>
            </SectionCard>
            <NextSteps
              isAdmin={isAdmin}
              propertyHref={propertyHref}
              roomsHref={roomsHref}
              mealPlansHref={mealPlansHref}
              spacesHref={spacesHref}
              extrasHref={extrasHref}
            />
          </div>
        </>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <SectionCard
            eyebrow="Property setup"
            title={
              landing.kind === 'denied'
                ? 'Property administration is not part of your role'
                : landing.kind === 'unassigned'
                  ? 'No property is assigned to you yet'
                  : 'Property setup could not be loaded'
            }
            titleLevel={2}
          >
            <p className="text-sm text-text-body">
              {landing.kind === 'denied'
                ? 'The property setup walk, property facts and the extras catalog are shown to members who administer a property. Ask your workspace administrator for a Hotel role with property administration if that is you.'
                : landing.kind === 'unassigned'
                  ? 'You can administer properties, but none is assigned to you. Ask your workspace administrator to assign you to a property; the setup walk appears here once they do.'
                  : 'Property data could not be fetched for this page. Reload to try again; your workspace is unaffected.'}
            </p>
            {landing.kind === 'error' ? (
              <a
                href="/dashboard"
                className={buttonVariants({ variant: 'outline', className: 'mt-4 min-h-11' })}
              >
                Reload the dashboard
              </a>
            ) : null}
          </SectionCard>
          <NextSteps
            isAdmin={isAdmin}
            propertyHref={null}
            roomsHref={null}
            mealPlansHref={null}
            spacesHref={null}
            extrasHref={null}
          />
        </div>
      )}
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  sub: string;
}) {
  return (
    <div className="studio-kpi-card bg-card p-5 sm:p-6">
      <span className="studio-kpi-icon">
        <Icon aria-hidden className="h-4 w-4" />
      </span>
      <Stat className="pr-8" label={label} value={value} sub={sub} />
    </div>
  );
}

function PropertySetup({ property }: { property: HotelLandingProperty }) {
  const selection = `?branchId=${encodeURIComponent(property.branchId)}`;
  return (
    <ReadinessChecklist
      eyebrow="Property setup"
      title={
        property.checklist.ready
          ? `${property.name} is ready to activate`
          : `Open ${property.name} for business`
      }
      description={property.activationSummary}
      rows={property.checklist.items.map((item) => ({
        key: item.key,
        step: item.step,
        label: item.label,
        state: item.state,
        why: item.why,
        // Every property-scoped link carries the property, so the walk never
        // lands on the chooser.
        href: item.href?.startsWith('/hotel/settings/') ? `${item.href}${selection}` : item.href,
        linkLabel: item.linkLabel,
      }))}
    />
  );
}

function PropertyRow({ property }: { property: HotelLandingProperty }) {
  const outstanding = property.checklist.blocking.length;
  return (
    <li className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-base font-medium text-text-strong">{property.name}</h3>
          <StatusPill
            status={property.checklist.ready ? 'Ready to activate' : `${outstanding} to do`}
            tone={property.checklist.ready ? 'success' : 'warning'}
          />
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-text-muted">
          <div>
            <dt className="sr-only">City</dt>
            <dd>{property.city}</dd>
          </div>
          <div>
            <dt className="sr-only">Mode</dt>
            <dd>{property.modeLabel}</dd>
          </div>
          <div>
            <dt className="sr-only">Check-in and check-out</dt>
            <dd className="whitespace-nowrap tabular-nums">
              In {property.checkInTime} · Out {property.checkOutTime}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Currency and extras</dt>
            <dd className="whitespace-nowrap tabular-nums">
              {property.currency} · {property.extrasCount}{' '}
              {property.extrasCount === 1 ? 'extra' : 'extras'}
            </dd>
          </div>
        </dl>
      </div>
      <Link
        className={buttonVariants({ variant: 'outline', className: 'shrink-0' })}
        href={`/hotel/settings/property?branchId=${encodeURIComponent(property.branchId)}`}
      >
        Open property
        <span className="sr-only"> settings for {property.name}</span>
      </Link>
    </li>
  );
}

function NextSteps({
  isAdmin,
  propertyHref,
  roomsHref,
  mealPlansHref,
  spacesHref,
  extrasHref,
}: {
  isAdmin: boolean;
  propertyHref: string | null;
  roomsHref: string | null;
  mealPlansHref: string | null;
  spacesHref: string | null;
  extrasHref: string | null;
}) {
  const steps = [
    propertyHref
      ? {
          href: propertyHref,
          label: 'Finish the property facts',
          detail: 'Mode, tax profile, audit time and business-date rule.',
        }
      : null,
    roomsHref
      ? {
          href: roomsHref,
          label: 'Add room types and rooms',
          detail: 'What the property sells, and the rooms, beds or units sold under each type.',
        }
      : null,
    mealPlansHref
      ? {
          href: mealPlansHref,
          label: 'Check the meal plans you sell',
          detail:
            'Room only and bed & breakfast open on sale; half and full board wait until you enable them.',
        }
      : null,
    spacesHref
      ? {
          href: spacesHref,
          label: 'Set up the function spaces',
          detail: 'Halls, lawns and boardrooms with their layouts, prices and turnaround times.',
        }
      : null,
    extrasHref
      ? {
          href: extrasHref,
          label: 'Build the extras catalog',
          detail: 'Breakfast, transfers, laundry: every charge a folio will name.',
        }
      : null,
    isAdmin
      ? {
          href: '/organization',
          label: 'Invite the team and assign Hotel roles',
          detail: 'Front desk, housekeeping and finance each get a property role.',
        }
      : null,
    {
      href: '/settings',
      label: 'Review your workspace settings',
      detail: 'Profile, password, two-factor and notification preferences.',
    },
  ].filter((step): step is NonNullable<typeof step> => step !== null);
  return (
    <SectionCard eyebrow="Next steps" title="What to do next" titleLevel={2}>
      <ol className="divide-y divide-border-subtle">
        {steps.map((step, index) => (
          <li key={step.href} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <span className="mt-0.5 font-mono text-xs text-text-faint tabular-nums">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="min-w-0">
              <Link
                // `text-foreground`, not `text-primary`: a tenant brand overrides
                // `--primary` in both themes with an unchecked colour (Studio §3).
                className="text-sm font-medium text-foreground underline underline-offset-4 hover:text-accent-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                href={step.href}
              >
                {step.label}
              </Link>
              <p className="text-xs text-text-muted">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-text-muted">
        Rates, reservations and folios are not available in this build; your DevFathom delivery team
        enables them.
      </p>
    </SectionCard>
  );
}
