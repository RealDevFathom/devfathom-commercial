/**
 * DEV-1053: the decision for every REST route (`src/app/api/**\/route.ts`): how does a
 * platform support session meet it?
 *
 * `tests/support-session-rest-routes.test.ts` fails when a route is missing from this file,
 * listed twice, or listed in a way its source does not bear out. Adding a route means adding
 * it here, under one of three headings. Paths are relative to `src/app/api`.
 *
 * 1. Tenant actor: the route acts as the signed-in member. It resolves the tenant actor, so a
 *    support session is known for what it is, and whatever it runs is under the support
 *    rule: tRPC procedures through the central rule, the assistant through its refused
 *    tools, and the route's own work is ordinary business data.
 * 2. Refuses support: the route answers a support session with a refusal of its own.
 * 3. Not a member session: the caller proves itself with something a support session does
 *    not hold or does not need (a device or bridge secret, an API or SCIM token, a webhook
 *    signature, a job secret, the platform operator's own session), or the route is public.
 */

/** Acts as the member. Each line says what the route does with that. */
export const REST_TENANT_ACTOR: Readonly<Record<string, string>> = {
  'trpc/[trpc]':
    'Every tRPC procedure. The support identity goes into the context and the central rule decides.',
  assistant:
    'The assistant. The support identity goes into the tool context; the refused tools answer with the rule.',
  'pharmacy/prescription-files':
    'Runs a pharmacyPrescriptions procedure with the support identity in the context.',
  'pharmacy/sop/evidence': 'Runs a pharmacySop procedure with the support identity in the context.',
  'restaurant/sop/evidence':
    'Runs a restaurantSopExecution procedure with the support identity in the context.',
  'pharmacy/supplier-documents/[id]':
    'Resolves the tenant actor, returns one supplier document the member’s branches may procure for, and audits the read.',
  'pharmacy/supplier-documents/upload':
    'Runs a pharmacySupplierLinks procedure with the support identity in the context.',
  'pharmacy/print':
    'Builds the tRPC context from the request and runs pharmacyPrinting procedures.',
  'restaurant/print-bridge':
    'Printer routing: builds the tRPC context from the request. The bridge half uses the device secret.',
  'restaurant/receipt-layout': 'Receipt layout settings, through the tRPC context.',
  'restaurant/reports/export': 'One report as a file, through restaurantReports procedures.',
  'ably-token':
    'A 30-minute realtime token for the channels the member is in. It expires with the visit.',
  'files/[name]':
    'Downloads a stored file the member may see. Owner data exports are refused here for everyone.',
  upload: 'Stores an attachment for the member. No credential.',
};

/** Answers a support session with a refusal. `via` names the module that holds the check. */
export const REST_REFUSES_SUPPORT: Readonly<Record<string, { why: string; via?: string }>> = {
  'password-reset': {
    why: 'Starting a password reset. Refused with the shared message and audited.',
  },
  'restaurant/devices/browser-enroll': {
    why: 'Device enrolment. Refused with the shared message and audited.',
  },
  'pharmacy/data-export': { why: 'The whole-business export is the owner’s own.' },
  'pharmacy/cameras/[cameraId]/stream': { why: 'Live video is not part of support access.' },
  'restaurant/cameras/[cameraId]/stream': { why: 'Live video is not part of support access.' },
  'pharmacy/counter/bind': {
    why: 'Binding an offline counter needs the member’s own session.',
    via: 'src/server/routers/pharmacy-offline-bind.ts',
  },
  ...Object.fromEntries(
    ['establish', 'lease', 'quota', 'reject', 'renew', 'replay', 'snapshot'].map((name) => [
      `pharmacy/counter/${name}`,
      {
        why: 'The offline counter transport needs the member’s own session and the device secret.',
        via: 'src/server/routers/pharmacy-offline.ts',
      },
    ])
  ),
};

/** What the caller proves itself with instead of a member session. */
export const REST_NOT_A_MEMBER_SESSION: Readonly<Record<string, readonly string[]>> = {
  'A restaurant terminal or kitchen screen: the enrolled device secret and the operator PIN.': [
    'restaurant/cash/day/close',
    'restaurant/cash/day/correct',
    'restaurant/cash/day/current',
    'restaurant/cash/day/preview',
    'restaurant/cash/drawer/close',
    'restaurant/cash/drawer/current',
    'restaurant/cash/drawer/movement',
    'restaurant/cash/drawer/open',
    'restaurant/catering/money',
    'restaurant/checkout/bill',
    'restaurant/checkout/loyalty',
    'restaurant/checkout/receipt',
    'restaurant/checkout/refund',
    'restaurant/checkout/summary',
    'restaurant/checkout/tender',
    'restaurant/checkout/uncomp',
    'restaurant/kds/ack',
    'restaurant/kds/bump',
    'restaurant/kds/delivery/queue',
    'restaurant/kds/delivery/transition',
    'restaurant/kds/operators',
    'restaurant/kds/queue',
    'restaurant/kds/recall',
    'restaurant/orders/add-item',
    'restaurant/orders/cancel',
    'restaurant/orders/close',
    'restaurant/orders/commercial-terms',
    'restaurant/orders/customer/attach',
    'restaurant/orders/customer/by-wallet',
    'restaurant/orders/customer/search',
    'restaurant/orders/delivery/addresses',
    'restaurant/orders/delivery/attach',
    'restaurant/orders/delivery/zones',
    'restaurant/orders/detail',
    'restaurant/orders/effective-menu',
    'restaurant/orders/fire',
    'restaurant/orders/hold',
    'restaurant/orders/mark-served',
    'restaurant/orders/merge-tables',
    'restaurant/orders/move-table',
    'restaurant/orders/open',
    'restaurant/orders/open-orders',
    'restaurant/orders/remake',
    'restaurant/orders/reprint-kot',
    'restaurant/orders/void',
    'restaurant/terminal/co-authorize',
    'restaurant/terminal/establish',
    'restaurant/terminal/heartbeat',
    'restaurant/terminal/layout',
    'restaurant/terminal/lock',
    'restaurant/terminal/operators',
    'restaurant/terminal/renew-composer-proof',
    'restaurant/terminal/switch',
    'restaurant/terminal/unlock',
  ],
  'A cold-chain sensor: its device secret.': ['pharmacy/cold-chain/readings'],
  'A print bridge: its bridge secret, or the one-time enrolment code the owner issued.': [
    'pharmacy/print-bridge',
    'restaurant/print-bridge/enroll',
  ],
  'An API token.': [
    'v1/boards/[id]',
    'v1/clients',
    'v1/clients/[id]',
    'v1/finance/summary',
    'v1/invoices',
    'v1/invoices/[id]',
    'v1/meetings',
    'v1/projects',
    'v1/projects/[id]',
    'v1/spec',
    'v1/tasks',
    'v1/tasks/[id]',
    'v1/tasks/[id]/comments',
    'v1/team',
    'v1/transactions',
    'v1/transactions/[id]',
  ],
  'A SCIM token, or the public SCIM discovery documents.': [
    'scim/v2/Groups',
    'scim/v2/Groups/[id]',
    'scim/v2/ResourceTypes',
    'scim/v2/Schemas',
    'scim/v2/ServiceProviderConfig',
    'scim/v2/Users',
    'scim/v2/Users/[id]',
  ],
  'A provider webhook: its signature.': [
    'meetings/webhooks/livekit',
    'pharmacy/sms/webhook',
    'pharmacy/whatsapp/webhook',
    'restaurant/webhooks/[source]',
  ],
  'A scheduled job: the job secret.': [
    'cron/demo-restaurants',
    'cron/outbound-effects',
    'pharmacy/whatsapp/back-in-stock',
    'pharmacy/whatsapp/khata-reminders',
    'pharmacy/whatsapp/reminders',
    'platform/jobs/process',
  ],
  'The platform operator’s own session, including starting and ending support access.': [
    'platform/control',
    'platform/mfa',
    'platform/session',
    'platform/support',
    'platform/workspace-requests/[id]',
    'support-session',
    'support-session/launch',
  ],
  'Public: health checks, sign-in, single sign-on, and links handed to customers.': [
    'auth/[...nextauth]',
    'health',
    'live',
    'login',
    'pharmacy/portal/[action]',
    'pharmacy/portal/prescription-upload',
    'ready',
    'restaurant/checkout/comp',
    'sso/oidc/[connectionId]/callback',
    'sso/oidc/[connectionId]/start',
    'sso/saml/[connectionId]/callback',
    'sso/saml/[connectionId]/metadata',
    'sso/saml/[connectionId]/start',
    'wallet/apple/v1/devices/[deviceLibraryIdentifier]/registrations/[passTypeIdentifier]',
    'wallet/apple/v1/devices/[deviceLibraryIdentifier]/registrations/[passTypeIdentifier]/[serialNumber]',
    'wallet/apple/v1/log',
    'wallet/apple/v1/passes/[passTypeIdentifier]/[serialNumber]',
    'wallet/enroll/start',
    'wallet/enroll/verify',
    'workspace-requests',
  ],
};
