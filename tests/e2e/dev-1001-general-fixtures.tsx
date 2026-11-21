import { type ReactNode, useState } from 'react';

import { AuditContent } from '@/app/(app)/audit-logs/audit-content';
import { ClientDetailContent } from '@/app/(app)/clients/[id]/client-detail-content';
import { EmailContent } from '@/app/(app)/email/email-content';
import { CreateInvoiceForm } from '@/app/(app)/finance/invoices-tab';
import { HRContent } from '@/app/(app)/hr/hr-content';
import { NotesContent } from '@/app/(app)/notes/notes-content';
import { OrganizationAdminContent } from '@/app/(app)/organization/organization-admin-content';
import { ProjectsContent } from '@/app/(app)/projects/projects-content';
import { ReviewsContent } from '@/app/(app)/reviews/reviews-content';
import { ApiTokensSection } from '@/app/(app)/settings/settings-content';
import { AddMemberModal } from '@/app/(app)/team/team-content';
import { RequestForm } from '@/app/login/register/request-form';
import { verticalCopy } from '@/app/login/vertical';
import { AuthShell } from '@/components/auth/auth-shell';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import { TerminalConsole } from '@/components/terminal/terminal-console';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import type { EntitlementView } from '@/lib/module-catalog';

export const generalEntitlements: EntitlementView = {
  organizationId: 'fixture-org',
  vertical: 'AGENCY',
  seatLimit: 10,
  activeSeats: 2,
  enabledModules: ['admin', 'hr', 'projects', 'notes', 'api'],
  modules: [],
  limits: {},
};

const departments = [
  { id: 'fixture-dept-a', key: 'ENGINEERING', name: 'Engineering', active: true },
  { id: 'fixture-dept-b', key: 'DESIGN', name: 'Design', active: true },
];
const roles = [
  {
    id: 'fixture-role-a',
    key: 'project-lead',
    name: 'Project lead',
    description: 'Fixture project access role',
    isSystem: false,
    permissions: [],
    _count: { users: 0 },
  },
];

/** Explicit local query results consumed by the isolated browser hook adapter. */
export const generalQueryData: Record<string, unknown> = {
  'projects.getAll': [],
  'clients.getAll': [
    { id: 'fixture-client-a', name: 'Example Client A', projects: [] },
    { id: 'fixture-client-b', name: 'Example Client B', projects: [] },
  ],
  'clients.getById': {
    id: 'fixture-client-a',
    name: 'Example Client A',
    status: 'ACTIVE',
    industry: 'Professional services',
    location: 'Example City',
    website: 'https://example.test',
    notes: 'Local client fixture for the visual review.',
    logo: null,
    timezone: 'Etc/UTC',
    projects: [],
    invoices: [],
    contracts: [],
    contacts: [],
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
  },
  'clients.getActivity': [],
  'clients.contractedValue': [],
  'team.getRoster': [
    { id: 'fixture-user', name: 'Fixture Owner', avatar: null },
    { id: 'fixture-member-1', name: 'Amina Example', avatar: null },
  ],
  'team.getHrOverview': {
    outToday: [],
    pendingLeaveTotal: 0,
    pendingLeave: [],
    recentHires: [],
    activeHeadcount: 2,
    upcomingAnniversaries: [],
  },
  'team.getLeaveRequests': [],
  'team.getLeaveBalances': {
    types: [
      { type: 'VACATION', entitledDays: 20, usedDays: 5, remaining: 15 },
      { type: 'SICK', entitledDays: 10, usedDays: 0, remaining: 10 },
      { type: 'REMOTE', entitledDays: 20, usedDays: 0, remaining: 20 },
    ],
  },
  'reviews.listCycles': [
    {
      id: 'fixture-cycle',
      name: 'November review cycle',
      startDate: new Date('2026-11-01T00:00:00.000Z'),
      endDate: new Date('2026-11-30T00:00:00.000Z'),
      status: 'OPEN',
      _count: { reviews: 0 },
    },
  ],
  'reviews.listReviews': [],
  'reviews.myReviews': [],
  'email.listMailboxes': [
    { id: 'fixture-mailbox-a', type: 'GMAIL', emailAddress: 'first@example.test' },
    { id: 'fixture-mailbox-b', type: 'OUTLOOK', emailAddress: 'second@example.test' },
  ],
  'email.providers': { GMAIL: true, OUTLOOK: true },
  'email.listMessages': [],
  'apiTokens.list': [],
  'apiTokens.usage': {},
  'organizationAdmin.departments': departments,
  'organizationAdmin.roles': roles,
  'organizationAdmin.askFathomSettings': {
    organizationId: 'fixture-org',
    askFathomEnabled: false,
  },
  'organizationAdmin.overview': {
    organization: {
      id: 'fixture-org',
      slug: 'fixture-studio',
      legalName: 'Example Studio',
      displayName: 'Example Studio',
      status: 'ACTIVE',
      vertical: 'AGENCY',
      deploymentMode: 'SHARED',
      timezone: 'Etc/UTC',
      locale: 'en',
      currency: 'PKR',
      primaryContactName: 'Fixture Owner',
      primaryContactEmail: 'owner@example.test',
      activatedAt: null,
      package: { name: 'Studio' },
      brand: null,
      emailSettings: null,
      domains: [],
      identityConnections: [],
      scimTokens: [],
      departments,
      roles,
      users: [
        {
          id: 'fixture-user',
          name: 'Fixture Owner',
          email: 'owner@example.test',
          role: 'ADMIN',
          status: 'ACTIVE',
          title: 'Administrator',
          department: 'ENGINEERING',
          organizationRoleId: null,
          lastActiveAt: null,
        },
      ],
      usageCounters: [],
    },
    entitlements: generalEntitlements,
    pharmacyBranches: [],
  },
  'audit.stats': { total: 0, last24h: 0, failures24h: 0, failures: 0 },
  'audit.filters': {
    categories: ['ORGANIZATION', 'PROJECT'],
    operations: ['CREATE', 'UPDATE'],
    sources: ['TRPC', 'AUTH'],
    outcomes: ['SUCCESS', 'FAILURE'],
    actors: [{ id: 'fixture-user', name: 'Fixture Owner', count: 0 }],
    branches: [{ id: 'fixture-branch', name: 'Main branch', code: 'MAIN' }],
  },
  'audit.list': { pages: [{ items: [], nextCursor: null }], pageParams: [] },
  'notes.list': [],
  'notes.notesMentioningMe': [],
  'notes.getById': {
    id: 'fixture-note',
    title: 'Fixture project notes',
    contentJson: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Local visual review fixture.' }] },
      ],
    },
    visibility: 'PRIVATE',
    authorId: 'fixture-user',
    author: { id: 'fixture-user', name: 'Fixture Owner', avatar: null },
    shares: [],
    mentions: [],
    linksTo: [],
    linksFrom: [],
    project: null,
    client: null,
    editable: true,
    updatedAt: new Date('2026-11-20T09:00:00.000Z'),
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
  },
};

function TeamInviteFixture() {
  const [open, setOpen] = useState(true);
  return (
    <EntitlementsProvider value={generalEntitlements}>
      <PageHeader eyebrow="WORKSPACE" heading="Invite a colleague" />
      <Button onClick={() => setOpen(true)}>Add Team Member</Button>
      {open && <AddMemberModal onClose={() => setOpen(false)} />}
    </EntitlementsProvider>
  );
}

function RegistrationFixture({ vertical }: { vertical: 'hotel' | 'pharmacy' | 'restaurant' }) {
  return (
    <AuthShell vertical={vertical} registration>
      <h1 className="mt-3 text-[clamp(2.1rem,4vw,3.15rem)] font-semibold leading-tight tracking-[-0.055em]">
        {verticalCopy[vertical].setup}
      </h1>
      <RequestForm vertical={vertical} />
    </AuthShell>
  );
}

export const generalScreens: Record<string, ReactNode> = {
  'workspace-clients': <ClientDetailContent clientId="fixture-client-a" />,
  'workspace-finance': (
    <>
      <PageHeader eyebrow="FINANCE" heading="Create invoice" />
      <CreateInvoiceForm onClose={() => {}} />
    </>
  ),
  'workspace-hr': <HRContent />,
  'workspace-reviews': <ReviewsContent />,
  'workspace-email': <EmailContent />,
  'workspace-settings': (
    <EntitlementsProvider value={generalEntitlements}>
      <PageHeader eyebrow="WORKSPACE" heading="API tokens" />
      <ApiTokensSection />
    </EntitlementsProvider>
  ),
  'workspace-projects': <ProjectsContent />,
  'workspace-audit': <AuditContent timeZone="Etc/UTC" />,
  'workspace-organization': (
    <EntitlementsProvider value={generalEntitlements}>
      <OrganizationAdminContent />
    </EntitlementsProvider>
  ),
  'workspace-team': <TeamInviteFixture />,
  'workspace-notes': <NotesContent selectedId="fixture-note" />,
  'registration-hotel': <RegistrationFixture vertical="hotel" />,
  'registration-pharmacy': <RegistrationFixture vertical="pharmacy" />,
  'registration-restaurant': <RegistrationFixture vertical="restaurant" />,
  'restaurant-terminal': <TerminalConsole />,
};

export const generalScreenSources = {
  'workspace-clients': ['src/app/(app)/clients/[id]/client-detail-content.tsx'],
  'workspace-finance': ['src/app/(app)/finance/invoices-tab.tsx'],
  'workspace-hr': ['src/app/(app)/hr/hr-content.tsx'],
  'workspace-reviews': ['src/app/(app)/reviews/reviews-content.tsx'],
  'workspace-email': ['src/app/(app)/email/email-content.tsx'],
  'workspace-settings': ['src/app/(app)/settings/settings-content.tsx'],
  'workspace-projects': ['src/app/(app)/projects/projects-content.tsx'],
  'workspace-audit': ['src/app/(app)/audit-logs/audit-content.tsx'],
  'workspace-organization': ['src/app/(app)/organization/organization-admin-content.tsx'],
  'workspace-team': ['src/app/(app)/team/team-content.tsx'],
  'workspace-notes': ['src/app/(app)/notes/notes-content.tsx'],
  'registration-hotel': ['src/app/login/register/request-form.tsx'],
  'registration-pharmacy': ['src/app/login/register/request-form.tsx'],
  'registration-restaurant': ['src/app/login/register/request-form.tsx'],
  'restaurant-terminal': ['src/components/terminal/terminal-console.tsx'],
};

/** Inert terminal transport responses; the browser runner must intercept these paths locally. */
export const terminalFixtureResponses = {
  '/api/restaurant/terminal/establish': {
    sessionToken: 'fixture-session-token',
    session: { id: 'fixture-session', state: 'LOCKED', establishedAt: '2026-11-20T09:00:00.000Z' },
    device: { id: 'fixture-device', branchId: 'fixture-branch' },
  },
  '/api/restaurant/terminal/operators': {
    operators: [
      { staffProfileId: 'fixture-operator-a', displayName: 'Amina Example', role: 'CASHIER' },
      { staffProfileId: 'fixture-operator-b', displayName: 'Bilal Example', role: 'MANAGER' },
    ],
  },
  '/api/restaurant/terminal/heartbeat': {
    session: { id: 'fixture-session', state: 'LOCKED', activeStaffProfileId: null },
    device: { id: 'fixture-device', health: 'HEALTHY' },
    serverTime: '2026-11-20T09:00:00.000Z',
  },
};
