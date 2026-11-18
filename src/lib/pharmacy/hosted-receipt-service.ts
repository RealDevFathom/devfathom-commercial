import 'server-only';

import { tenantHostUrl } from '@/lib/tenancy/host-routing';
import { afterTenantTransaction } from '@/lib/side-effects/scope';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { readCounterReceipt } from './counter';
import {
  HOSTED_RECEIPT_TOKEN_PATTERN,
  HostedReceiptError,
  assertNeutralWhatsAppParameters,
  hashHostedReceiptToken,
  hostedReceiptExpiresAt,
  hostedReceiptTtlDays,
  isRxSaleLine,
  mintHostedReceiptToken,
  receiptLinkParameters,
  receiptMethodLabel,
} from './hosted-receipt';
import { hostedReceiptView, type HostedReceiptView } from './hosted-receipt-view';
import { medicineNameSet, readTenantMedicineNames } from './medicine-names';
import { claimMessageLogInTransaction, sendClaimedMessage } from './whatsapp/message-log';
import { canMessageCustomer, normalizeWhatsAppNumber, phoneLast4 } from './whatsapp/messages';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  type WhatsAppConfig,
  type WhatsAppProvider,
  type WhatsAppTemplateKey,
} from './whatsapp/provider';

export type HostedReceiptScope = { organizationId: string; branchId: string };
/**
 * QUEUED: the claim and link are written and delivery runs after the request's
 * transaction commits, so the counter never reports a delivery it cannot know.
 * DUPLICATE: a receipt for this sale was already requested today.
 */
export type HostedReceiptSendOutcome = 'QUEUED' | 'DUPLICATE';
export type HostedReceiptDelivery = 'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED' | 'SKIPPED';

/** Run delivery after the owning tenant transaction ends (immediately outside one). */
function deferUntilCommitted(work: () => Promise<unknown>): void {
  afterTenantTransaction(() => {
    void work().catch((error: unknown) => {
      console.error(
        '[pharmacy] hosted receipt delivery failed',
        error instanceof Error ? error.name : 'error'
      );
    });
  });
}

/** The deployment's sender must belong to this tenant and the template must be approved. */
function senderReady(
  config: WhatsAppConfig,
  organizationId: string,
  template: WhatsAppTemplateKey
): boolean {
  return Boolean(
    config.organizationId === organizationId &&
    config.phoneNumberId &&
    config.templates[template] &&
    (config.provider !== 'meta' || (config.accessToken && config.liveSendApproved))
  );
}

function localDay(now: Date, timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: workspaceTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Counter action, taken only when the customer asks for a WhatsApp receipt: the
 * sale's linked customer must be active, opted in to WhatsApp and reachable.
 * At most one receipt message per sale per local day; each send mints a fresh
 * link because the token itself is never stored.
 */
export async function sendWhatsAppReceiptLink(input: {
  db: ScopedDb;
  scope: HostedReceiptScope;
  saleId: string;
  actorUserId: string;
  now?: Date;
  config?: WhatsAppConfig;
  provider?: WhatsAppProvider;
  env?: Record<string, string | undefined>;
  /** Tests observe delivery; production waits for the request transaction to end. */
  defer?: (work: () => Promise<HostedReceiptDelivery>) => void;
}): Promise<{ outcome: HostedReceiptSendOutcome; expiresAt: string | null; rxProtected: boolean }> {
  const { db, scope } = input;
  const now = input.now ?? new Date();
  const config = input.config ?? readWhatsAppConfig();
  if (!senderReady(config, scope.organizationId, 'receiptLink'))
    throw new HostedReceiptError('NOT_CONFIGURED');

  const [organization, branch, sale] = await Promise.all([
    db.organization.findUnique({
      where: { id: scope.organizationId },
      select: { slug: true, timezone: true, currency: true },
    }),
    db.pharmacyBranch.findFirst({
      where: { id: scope.branchId, organizationId: scope.organizationId },
      select: { name: true },
    }),
    db.pharmacySale.findFirst({
      where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
      select: {
        status: true,
        receiptNumber: true,
        completedAt: true,
        customerId: true,
        lines: {
          select: {
            prescriptionLineId: true,
            medicine: {
              select: {
                rx: true,
                controlled: true,
                restricted: true,
                productName: true,
                brandName: true,
                strengths: { select: { ingredient: { select: { name: true } } } },
              },
            },
          },
        },
      },
    }),
  ]);
  if (
    !organization ||
    !branch ||
    !sale ||
    sale.status !== 'COMPLETED' ||
    sale.receiptNumber === null ||
    !sale.completedAt
  )
    throw new HostedReceiptError('NOT_SETTLED');
  if (!sale.customerId) throw new HostedReceiptError('NO_CUSTOMER');

  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId: scope.organizationId, id: sale.customerId },
    select: {
      id: true,
      patientId: true,
      active: true,
      whatsappOptIn: true,
      patient: { select: { phone: true } },
    },
  });
  if (!customer || !canMessageCustomer(customer)) throw new HostedReceiptError('NO_CONSENT');
  const to = normalizeWhatsAppNumber(customer.patient.phone);
  if (!to) throw new HostedReceiptError('NO_PHONE');

  const receipt = await readCounterReceipt(db, scope, input.saleId, {
    name: branch.name,
    currency: organization.currency ?? 'PKR',
    timeZone: workspaceTimezone(organization.timezone),
  });
  const { token, tokenHash } = mintHostedReceiptToken();
  const url = tenantHostUrl(organization.slug, `/receipt/${token}`);
  if (!url) throw new HostedReceiptError('LINK_HOST_NOT_CONFIGURED');
  const parameters = receiptLinkParameters({
    branchName: branch.name,
    receiptNumber: sale.receiptNumber,
    currency: receipt.currency,
    netMinor: receipt.totals.netMinor,
    method: receiptMethodLabel(receipt.tenders),
    url,
  });
  // The linter checks the tenant catalogue plus this sale's own names and salts.
  const names = await readTenantMedicineNames(db);
  for (const name of medicineNameSet(
    sale.lines.flatMap(({ medicine }) => [
      medicine.productName,
      medicine.brandName,
      ...medicine.strengths.map((strength) => strength.ingredient.name),
    ])
  ))
    names.add(name);
  assertNeutralWhatsAppParameters(parameters, names);

  // Recorded for audit only: the link holder sees every line either way.
  const rxProtected = sale.lines.some(isRxSaleLine);
  const expiresAt = hostedReceiptExpiresAt(now, hostedReceiptTtlDays(input.env));
  const entry = {
    organizationId: scope.organizationId,
    kind: 'RECEIPT_LINK' as const,
    dedupeKey: `receipt-link:${input.saleId}:${localDay(now, organization.timezone)}`,
    branchId: scope.branchId,
    customerId: customer.id,
    patientId: customer.patientId,
    phoneLast4: phoneLast4(to),
    templateName: config.templates.receiptLink,
  };
  const claim = await db.$transaction(async (inner) => {
    const tx = inner as ScopedDb;
    const logId = await claimMessageLogInTransaction(tx, {
      ...entry,
      direction: 'OUTBOUND',
      status: 'PENDING',
    });
    if (!logId) return null;
    const link = await tx.pharmacyHostedReceipt.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: input.saleId,
        customerId: customer.id,
        tokenHash,
        rxProtected,
        expiresAt,
        createdByUserId: input.actorUserId,
      },
      select: { id: true },
    });
    return { logId, linkId: link.id };
  });
  if (!claim) return { outcome: 'DUPLICATE', expiresAt: null, rxProtected };

  // The tRPC request holds one tenant transaction: an independent sender
  // transaction must not run until the claim and link have committed.
  const provider = input.provider ?? createWhatsAppProvider(config);
  (input.defer ?? deferUntilCommitted)(async () => {
    // Deferred work also runs after a rollback; only a committed, still-pending
    // claim may be sent.
    const committed = await withTenantDb(scope.organizationId, (tx) =>
      tx.pharmacyMessageLog.findFirst({
        where: { id: claim.logId, status: 'PENDING', providerMessageId: null },
        select: { id: true },
      })
    );
    if (!committed) return 'SKIPPED';
    const outcome = await sendClaimedMessage(entry, claim.logId, () =>
      provider.sendTemplate({ to, template: 'receiptLink', parameters })
    );
    if (outcome === 'FAILED')
      await withTenantDb(scope.organizationId, (tx) =>
        tx.pharmacyHostedReceipt.updateMany({
          where: { id: claim.linkId },
          data: { revokedAt: now },
        })
      );
    return outcome;
  });
  return { outcome: 'QUEUED', expiresAt: expiresAt.toISOString(), rxProtected };
}

async function liveLink(db: ScopedDb, token: string, now: Date) {
  if (!HOSTED_RECEIPT_TOKEN_PATTERN.test(token)) return null;
  return db.pharmacyHostedReceipt.findFirst({
    where: { tokenHash: hashHostedReceiptToken(token), revokedAt: null, expiresAt: { gt: now } },
  });
}

type LiveLink = NonNullable<Awaited<ReturnType<typeof liveLink>>>;

async function receiptFor(db: ScopedDb, link: LiveLink): Promise<HostedReceiptView | null> {
  const scope = { organizationId: link.organizationId, branchId: link.branchId };
  const [branch, organization, sale] = await Promise.all([
    db.pharmacyBranch.findFirst({
      where: { id: link.branchId, organizationId: link.organizationId },
      select: { name: true },
    }),
    db.organization.findUnique({
      where: { id: link.organizationId },
      select: { currency: true, timezone: true },
    }),
    db.pharmacySale.findFirst({
      where: { id: link.saleId, organizationId: link.organizationId, branchId: link.branchId },
      select: { status: true },
    }),
  ]);
  if (!branch || sale?.status !== 'COMPLETED') return null;
  const receipt = await readCounterReceipt(db, scope, link.saleId, {
    name: branch.name,
    currency: organization?.currency ?? 'PKR',
    // DEV-943: the hosted receipt's time is read on the shop's own clock.
    timeZone: workspaceTimezone(organization?.timezone),
  });
  return hostedReceiptView(receipt);
}

/**
 * The hosted page's read. Owner decision (15 Nov 2026): the link holder sees the
 * whole receipt, every line with name, strength, quantity and price, for
 * over-the-counter and prescription sales alike, with no further check. The
 * unguessable token is the only key; it opens this one receipt and nothing else,
 * and an unknown, malformed, expired or revoked token returns nothing.
 */
export async function openHostedReceipt(
  organizationId: string,
  token: string,
  now: Date = new Date()
): Promise<HostedReceiptView | null> {
  if (!HOSTED_RECEIPT_TOKEN_PATTERN.test(token)) return null;
  return withTenantDb(organizationId, async (db) => {
    const link = await liveLink(db, token, now);
    return link ? receiptFor(db, link) : null;
  });
}
