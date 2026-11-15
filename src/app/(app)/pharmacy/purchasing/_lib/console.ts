import { APPROVAL_BLOCKED } from '@/lib/pharmacy/purchase-approval';
import { ZodError } from 'zod';

import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { workspaceToday } from '@/lib/timezone';
import { pharmacyPurchasingRouter } from '@/server/routers/pharmacy-purchasing';
import { createTRPCContext } from '@/server/trpc';

/**
 * Shared plumbing for the four PH-PUR consoles (PRD §6.3 PUR-01..PUR-06).
 *
 * Nothing here decides anything the domain decides. It resolves the tenant the
 * way the rest of the app resolves it, turns a thrown `TRPCError` back into the
 * field it came from, and formats minor units — the three things every one of
 * the surfaces would otherwise reimplement slightly differently.
 */

export const PURCHASING_ROUTE = '/pharmacy/purchasing';

export const PURCHASING_TABS = [
  { href: PURCHASING_ROUTE, label: 'Overview' },
  { href: `${PURCHASING_ROUTE}/suppliers`, label: 'Suppliers' },
  { href: `${PURCHASING_ROUTE}/orders`, label: 'Requisitions & orders' },
  { href: `${PURCHASING_ROUTE}/reorder`, label: 'Reorder' },
  { href: `${PURCHASING_ROUTE}/receiving`, label: 'Goods in' },
  { href: `${PURCHASING_ROUTE}/returns`, label: 'Returns & claims' },
] as const;

/**
 * Resolve the tenant actor first, then hand the resolved session and
 * organization to the context factory.
 *
 * `createTRPCContext()` with no argument cannot stand in for this: it forwards
 * `{ request: undefined, session: undefined }` to `resolveTenantActor`, whose
 * `'session' in options` check reads that explicitly-undefined key as "the
 * caller already resolved the session", so the organization is always null and
 * the factory throws `Workspace not found.` as an unhandled Server Component
 * error on every request and every host.
 */
export async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

export type PurchasingCaller = ReturnType<typeof pharmacyPurchasingRouter.createCaller>;

/**
 * A caller for a Server Function. Server Functions are reachable by direct POST
 * and not only through the form that renders them, so every action re-resolves
 * the actor here rather than closing over the one the page rendered with; the
 * router's module gate and the tenant-scoped client then apply unchanged.
 */
export async function purchasingCaller(): Promise<PurchasingCaller | null> {
  const ctx = await tenantContext();
  return ctx ? pharmacyPurchasingRouter.createCaller(ctx) : null;
}

export const NO_ACTOR = 'Your session is no longer active. Sign in again and retry.';

// ---------------------------------------------------------------------------
// UX rule 11 — a validation error names the field and the fix, inline
// ---------------------------------------------------------------------------

/**
 * The domain speaks in reason codes (`RETURN_WINDOW_CLOSED`, `SELF_APPROVAL`)
 * because a reason code is stable and a sentence is not. The operator does not
 * read reason codes, so each one is given the sentence it means — and, where
 * one exists, the form field that is wrong.
 */
const DOMAIN_MESSAGES: Record<string, { message: string; field?: string }> = {
  SUPPLIER_NOT_AUTHORIZED: {
    message:
      'This supplier is not authorized to trade with the pharmacy. Authorize it on the supplier page first.',
    field: 'supplierId',
  },
  SUPPLIER_LICENCE_EXPIRED: {
    message:
      'This supplier has no unexpired verified licence on file. Record and verify a current licence first.',
    field: 'supplierId',
  },
  SELF_APPROVAL: {
    message:
      'Whoever raised the demand or drafted the order cannot approve it. Ask a second person to decide.',
  },
  SELF_VERIFICATION: {
    message:
      'Whoever filed a licence cannot also verify it. Ask a colleague with purchasing access to verify it from the licence list.',
    field: 'verified',
  },
  INVALID_TRANSITION: {
    message: 'The document has already moved on. Reload the page to see its current state.',
  },
  INVALID_QUANTITY: { message: 'Quantities must be whole, non-negative numbers.' },
  INVALID_MONEY: { message: 'Money must be a whole, non-negative amount.' },
  INVALID_RATE: { message: 'A rate must be between 0% and 100%.' },
  CROSS_TENANT_REFERENCE: { message: 'That record is not part of this workspace.' },
  CROSS_BRANCH_REFERENCE: { message: 'That record belongs to a different branch.' },
  MISSING_PACK_CONVERSION: {
    message: 'This pack level has no effective conversion. Set one on the medicine first.',
    field: 'packLevelId',
  },
  PACK_CONVERSION_MISMATCH: {
    message:
      "The units per pack on this line do not match the medicine's pack setup. Reload the page so the line uses the current pack conversion.",
    field: 'packLevelId',
  },
  RETURN_WINDOW_CLOSED: {
    message: "The supplier's return window has closed for one of these lines.",
    field: 'returnWindowEndsAt',
  },
  ALREADY_CLAIMED: {
    message: 'That quantity is already reserved by another claim and cannot be claimed twice.',
    field: 'quantityUnits',
  },
  OVER_ALLOCATION: {
    message: 'That would allocate more credit than the debit note is owed.',
    field: 'amountMinor',
  },
  BLOCKED_STOCK: { message: 'That stock is quarantined or recalled and cannot be moved.' },
  REVERSAL_STOCK_MOVED: {
    message:
      'Some of the stock this receipt brought in has since been sold, transferred, quarantined or written off, so the receipt cannot be reversed. Return the remaining stock to the supplier or write it off instead.',
  },
  REVERSAL_PACKS_OPENED: {
    message:
      'Sealed packs from this receipt have since been opened into loose units, so the receipt cannot be reversed exactly. Return the remaining stock to the supplier or write it off instead.',
  },
  COLD_CHAIN_STORAGE_REQUIRED: {
    message:
      'This medicine requires cold-chain storage. Choose a validated cold-chain zone before posting the receipt.',
    field: 'stockLocationId',
  },
  NOT_FOUND: { message: 'That record no longer exists. Reload the page.' },
  CONTROLLED_WITNESS_REQUIRED: {
    message:
      'A controlled medicine needs the qualified person named on the receipt to enter their PIN before it can be posted.',
    field: 'witnessPin',
  },
  DUPLICATE_SUPPLIER_INVOICE: {
    message:
      'This supplier invoice is already filed as a receipt from this supplier. A bill is received once; check the invoice number against the receipts list.',
    field: 'supplierInvoiceRef',
  },
  DUPLICATE_SERIAL: {
    message:
      'This GTIN and serial were already received in this pharmacy. Treat it as a duplicate pack and do not stock it in again.',
    field: 'serialNumber',
  },
  GS1_INVALID: {
    message:
      'That 2D code could not be read. Scan it again, or enter the batch and expiry from the carton.',
    field: 'serialNumber',
  },
  GTIN_MEDICINE_MISMATCH: {
    message: 'This GTIN is not the barcode of the medicine on this line.',
    field: 'serialNumber',
  },
  SERIALIZED_PACK_QUANTITY: {
    message:
      "A serialized pack is received one pack per line. Scan each pack's 2D code; its serial is never copied to other packs.",
    field: 'receivedPacks',
  },
  EXPIRED_PACK: {
    message:
      'This pack is already expired. Reject the units into quarantine, or do not receive it.',
    field: 'printedExpiry',
  },
};

const KNOWN_REJECTIONS = new Set([
  'SELF_VERIFICATION',
  APPROVAL_BLOCKED,
  'DUPLICATE_SERIAL',
  'DUPLICATE_SUPPLIER_INVOICE',
  'EXPIRED_PACK',
  'GS1_INVALID',
  'GTIN_MEDICINE_MISMATCH',
  'PACK_CONVERSION_MISMATCH',
  'SERIALIZED_PACK_QUANTITY',
  'REVERSAL_STOCK_MOVED',
  'REVERSAL_PACKS_OPENED',
]);

export type ActionFailure = { message: string; field?: string };

/** Explicit local validation, never inferred from a generic Error message. */
export class PurchasingValidationError extends Error {}

/** One guard per action invocation. Argument parsing finishes before write starts.
 * Once a router mutation is invoked, even a typed rejection is conservative:
 * this layer cannot prove whether an unknown server error followed a commit.
 */
export function purchasingOutcome() {
  let writeStarted = false;
  return {
    write<Args extends unknown[], Result>(mutation: (...args: Args) => Promise<Result>) {
      return (...args: Args): Promise<Result> => {
        writeStarted = true;
        return mutation(...args);
      };
    },
    failure(error: unknown, fallback: string): ActionFailure & { outcome: 'rejected' | 'unknown' } {
      const raw = error instanceof Error ? error.message : '';
      const known =
        (!writeStarted && error instanceof PurchasingValidationError) ||
        zodFailure(error) !== null ||
        KNOWN_REJECTIONS.has(raw) ||
        uniqueViolation(error, raw);
      return {
        ...actionFailure(error, fallback),
        outcome: known ? 'rejected' : 'unknown',
      };
    },
  };
}

function zodFailure(error: unknown): ActionFailure | null {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  if (!(cause instanceof ZodError)) return null;
  const issue = cause.issues[0];
  if (!issue) return null;
  // Form controls are named for the leaf they bind to (`batchNumber`,
  // `expiresAt`), so the leaf of the Zod path is what focuses the right input;
  // a numeric leaf (an array index) means the whole row is at fault.
  const segments = issue.path.filter((segment) => typeof segment === 'string') as string[];
  const field = segments[segments.length - 1];
  // `expiresAt` reads as "Expires at", not "Expires At": the field name is one
  // phrase, and title-casing every camel hump turns a sentence into a header.
  const label = field
    ? field
        .replace(
          /([a-z0-9])([A-Z])/g,
          (_, head: string, tail: string) => `${head} ${tail.toLowerCase()}`
        )
        .replace(/^./, (character) => character.toUpperCase())
    : null;
  return {
    message: label ? `${label}: ${issue.message}` : issue.message,
    ...(field ? { field } : {}),
  };
}

/**
 * Turn whatever an action threw into one sentence and, where the cause names
 * one, the field to focus. Never surfaces a reason code or a stack to the
 * operator, and never swallows the cause either: an unrecognised failure keeps
 * its own message rather than being flattened to "something went wrong".
 */
export function actionFailure(error: unknown, fallback: string): ActionFailure {
  if (error instanceof PurchasingValidationError) {
    const field = (error as PurchasingValidationError & { field?: string }).field;
    return { message: error.message, ...(field ? { field } : {}) };
  }
  const zod = zodFailure(error);
  if (zod) return zod;
  const raw = error instanceof Error ? error.message : '';
  const domain = DOMAIN_MESSAGES[raw];
  if (domain) return domain;
  const constraint = constraintFailure(error, raw);
  if (constraint) return constraint;
  return { message: raw || fallback };
}

/**
 * A reference collision is the most common way one of these forms fails, and
 * the database says so in a sentence full of table names and error codes. The
 * operator needs "that reference is already used", and the field it is on —
 * anything else is the network tab wearing a banner (UX rule 11).
 */
function uniqueViolation(error: unknown, raw: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002' || /unique constraint/i.test(raw) || /duplicate key value/i.test(raw);
}

function constraintTarget(error: unknown): string {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (Array.isArray(target)) return target.join(' ');
  return typeof target === 'string' ? target : '';
}

function constraintFailure(error: unknown, raw: string): ActionFailure | null {
  if (!uniqueViolation(error, raw)) return null;
  if (/serial|gtin/i.test(`${constraintTarget(error)} ${raw}`)) {
    return {
      message:
        'This GTIN and serial were already received in this pharmacy. Treat it as a duplicate pack and do not stock it in again.',
      field: 'serialNumber',
    };
  }
  return {
    message:
      'That reference is already used in this workspace. References identify one document, so pick another.',
    field: 'reference',
  };
}

// ---------------------------------------------------------------------------
// Redirect targets — a notice, the field that failed, and the kept selection
// ---------------------------------------------------------------------------

export type Notice = {
  message: string;
  kind: 'success' | 'error';
  outcome?: 'rejected' | 'unknown';
  field?: string;
};

/**
 * UX rule 6: selection is carried through every redirect, so an error never
 * silently reassigns which record the operator was working on.
 */
export function destination(
  route: string,
  notice: Notice,
  keep: Record<string, string | undefined> = {}
): string {
  const params = new URLSearchParams({
    notice: notice.message,
    kind: notice.kind,
    outcome: notice.kind === 'success' ? 'committed' : (notice.outcome ?? 'unknown'),
  });
  if (notice.field) params.set('field', notice.field);
  for (const [key, value] of Object.entries(keep)) if (value) params.set(key, value);
  return `${route}?${params}`;
}

export type SearchQuery = Record<string, string | string[] | undefined>;

export function param(query: SearchQuery, key: string): string | undefined {
  const value = query[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function noticeFrom(query: SearchQuery): Notice | null {
  const message = param(query, 'notice');
  if (!message) return null;
  return {
    message,
    kind: param(query, 'kind') === 'error' ? 'error' : 'success',
    ...(param(query, 'field') ? { field: param(query, 'field') } : {}),
  };
}

// ---------------------------------------------------------------------------
// Form field readers
// ---------------------------------------------------------------------------

export function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

export function optionalField(form: FormData, name: string): string | undefined {
  return field(form, name) || undefined;
}

/**
 * Every quantity and money field on these surfaces is a whole number: canonical
 * units are integers by §8A invariant 1 and money is minor units. Parsing here
 * rather than letting `Number()` produce a NaN keeps the failure attached to
 * the field that caused it.
 */
export function integerField(form: FormData, name: string, label: string): number {
  const raw = field(form, name);
  if (!/^-?\d+$/.test(raw)) {
    throw Object.assign(new PurchasingValidationError(`${label}: enter a whole number.`), {
      field: name,
    });
  }
  return Number(raw);
}

export function optionalIntegerField(
  form: FormData,
  name: string,
  label: string,
  fallback: number
): number {
  return field(form, name) ? integerField(form, name, label) : fallback;
}

/**
 * Money is captured in rupees because that is what is printed on the invoice,
 * and stored in paisa because §8A forbids a float anywhere near a cost. Two
 * decimal places exactly; a third would be silently dropped.
 */
export function moneyFieldMinor(form: FormData, name: string, label: string): number {
  const raw = field(form, name);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw Object.assign(
      new PurchasingValidationError(`${label}: enter an amount like 1250 or 1250.75.`),
      {
        field: name,
      }
    );
  }
  const [rupees, paisa = ''] = raw.split('.');
  return Number(rupees) * 100 + Number(paisa.padEnd(2, '0'));
}

export function optionalMoneyFieldMinor(
  form: FormData,
  name: string,
  label: string,
  fallback: number
): number {
  return field(form, name) ? moneyFieldMinor(form, name, label) : fallback;
}

/**
 * `<input type="date">` posts `YYYY-MM-DD`, which `new Date()` reads as UTC
 * midnight. Expiry and invoice dates are calendar dates, so UTC midnight is the
 * correct and stable reading — a local-time parse would move a 30 June expiry
 * to 29 June for anybody east of Greenwich.
 */
export function dateField(form: FormData, name: string, label: string): Date {
  const raw = field(form, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw Object.assign(new PurchasingValidationError(`${label}: choose a date.`), { field: name });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

export function optionalDateField(form: FormData, name: string, label: string): Date | undefined {
  return field(form, name) ? dateField(form, name, label) : undefined;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const RUPEES = new Intl.NumberFormat('en-PK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(minor: number | null | undefined): string {
  if (minor == null) return '—';
  const negative = minor < 0;
  return `${negative ? '−' : ''}PKR ${RUPEES.format(Math.abs(minor) / 100)}`;
}

/** Per-unit landed cost arrives in minor × 1e6; four decimals is the useful precision. */
export function microMoney(microMinor: number | null | undefined): string {
  if (microMinor == null) return '—';
  return `PKR ${(microMinor / 1_000_000 / 100).toFixed(4)}`;
}

export function units(value: number): string {
  return `${value.toLocaleString('en-PK')} units`;
}

export function bps(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

export function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(value)
  );
}

export function dateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

/** `YYYY-MM-DD` for a `defaultValue` on `<input type="date">`. */
export function dateInputValue(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Today in the workspace's zone: a GRN keyed in 00:00–04:59 PKT is today's, not yesterday's. */
export function today(timeZone: string | null | undefined): string {
  return workspaceToday(timeZone);
}
