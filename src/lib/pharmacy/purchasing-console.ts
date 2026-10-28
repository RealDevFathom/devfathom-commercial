import { soloOwnerEligible } from './solo-approval';
import { actorCanProcure } from './procurement-access';
import { assignedRegisterBranchIds } from './controlled-register';
/**
 * PH-PUR read models — PRD §6.3 PUR-01..PUR-06 as the purchasing consoles need
 * to show them.
 *
 * The PUR lane composed its writes and its refusals first; nothing in it reads
 * back a list, because a service that only ever posts does not need one. Every
 * function here is a projection over rows the write side already owns — no new
 * table, no derived state stored anywhere, and no decision the domain has not
 * already made.
 *
 * Two standing rules shape every query below:
 *
 * - **UX rule 16.** Every `where` carries an explicit `organizationId`. Forced
 *   RLS is the second wall; a picker that offered another tenant's supplier
 *   would be a security defect before it was a UX one.
 * - **UX rule 1.** A surface never asks for an identifier or a multiplier the
 *   application can resolve. Pack conversions, supplier eligibility and return
 *   windows are computed here so the operator picks a name and reads a number
 *   rather than typing either.
 */

import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { parseGs1DataMatrix, type Gs1Warning } from './gs1-datamatrix';
import { normalizeMedicineText } from './medicine';
import { packConversions, type PackLevelNode } from './pack-conversion';
import { assertSupplierEligible, PharmacyPurchasingError } from './purchasing';
import { creditPosition } from './supplier-returns';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type OrganizationScope = { organizationId: string };
export type BranchScope = OrganizationScope & { branchId: string };

/**
 * PUR-01 — why a supplier may or may not be ordered from *right now*, in the
 * words the console prints. `assertSupplierEligible` owns the decision; this
 * only names it, so the badge and the refusal can never disagree.
 */
export type SupplierEligibility =
  | { orderable: true; reason: null }
  | { orderable: false; reason: 'NOT_AUTHORIZED' | 'NO_VALID_LICENCE' };

export type SupplierLicenceView = {
  id: string;
  licenceType: string;
  licenceNumber: string;
  issuingAuthority: string;
  issuedAt: Date;
  expiresAt: Date;
  evidenceUri: string | null;
  verified: boolean;
  superseded: boolean;
  /** Negative once the licence has lapsed, so the console can say by how long. */
  daysToExpiry: number;
};

export type SupplierSummary = {
  id: string;
  name: string;
  legalName: string | null;
  authorized: boolean;
  active: boolean;
  serviceArea: string | null;
  contactName: string | null;
  contactPhone: string | null;
  paymentTermsDays: number;
  creditLimitMinor: number;
  eligibility: SupplierEligibility;
  /** The licence the eligibility decision rests on, or the latest filing if none qualifies. */
  governingLicence: SupplierLicenceView | null;
  licences: SupplierLicenceView[];
};

const DAY_MS = 86_400_000;

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function eligibility(
  supplier: { authorized: boolean },
  licences: readonly { expiresAt: Date; verified: boolean }[],
  at: Date
): SupplierEligibility {
  try {
    assertSupplierEligible({ authorized: supplier.authorized, licences, at });
    return { orderable: true, reason: null };
  } catch (error) {
    if (error instanceof PharmacyPurchasingError) {
      return {
        orderable: false,
        reason: error.reason === 'SUPPLIER_NOT_AUTHORIZED' ? 'NOT_AUTHORIZED' : 'NO_VALID_LICENCE',
      };
    }
    throw error;
  }
}

type LicenceRow = {
  id: string;
  licenceType: string;
  licenceNumber: string;
  issuingAuthority: string;
  issuedAt: Date;
  expiresAt: Date;
  evidenceUri: string | null;
  verifiedAt: Date | null;
  supersedesId: string | null;
};

/**
 * Licence evidence is append-only, so a correction arrives as a *new* row
 * naming the one it replaces. A filing that something else supersedes is still
 * displayed — the audit trail is the point — but it is marked, because a
 * superseded licence is paperwork rather than permission.
 */
function licenceViews(rows: readonly LicenceRow[], at: Date): SupplierLicenceView[] {
  const superseded = new Set(rows.map((row) => row.supersedesId).filter(Boolean) as string[]);
  return rows
    .map((row) => ({
      id: row.id,
      licenceType: row.licenceType,
      licenceNumber: row.licenceNumber,
      issuingAuthority: row.issuingAuthority,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      evidenceUri: row.evidenceUri,
      verified: row.verifiedAt !== null,
      superseded: superseded.has(row.id),
      daysToExpiry: daysBetween(at, row.expiresAt),
    }))
    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime() || a.id.localeCompare(b.id));
}

function summarizeSupplier(
  supplier: {
    id: string;
    name: string;
    legalName: string | null;
    authorized: boolean;
    active: boolean;
    serviceArea: string | null;
    contactName: string | null;
    contactPhone: string | null;
    paymentTermsDays: number;
    creditLimitMinor: number;
    licences: LicenceRow[];
  },
  at: Date
): SupplierSummary {
  const licences = licenceViews(supplier.licences, at);
  // `assertSupplierEligible` counts every verified, unexpired filing, including
  // a superseded one; mirroring that here rather than pre-filtering keeps the
  // badge and the refusal the same decision.
  const evidence = licences.map((licence) => ({
    expiresAt: licence.expiresAt,
    verified: licence.verified,
  }));
  const governing =
    licences.find((licence) => licence.verified && licence.daysToExpiry >= 0) ??
    licences[0] ??
    null;
  return {
    id: supplier.id,
    name: supplier.name,
    legalName: supplier.legalName,
    authorized: supplier.authorized,
    active: supplier.active,
    serviceArea: supplier.serviceArea,
    contactName: supplier.contactName,
    contactPhone: supplier.contactPhone,
    paymentTermsDays: supplier.paymentTermsDays,
    creditLimitMinor: supplier.creditLimitMinor,
    eligibility: eligibility(supplier, evidence, at),
    governingLicence: governing,
    licences,
  };
}

export async function listSuppliers(
  db: ScopedDb,
  scope: OrganizationScope,
  options: { at?: Date; includeInactive?: boolean } = {}
): Promise<SupplierSummary[]> {
  const at = options.at ?? new Date();
  const suppliers = await db.pharmacySupplier.findMany({
    where: {
      organizationId: scope.organizationId,
      ...(options.includeInactive ? {} : { active: true }),
    },
    include: { licences: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return suppliers.map((supplier) => summarizeSupplier(supplier, at));
}

// ---------------------------------------------------------------------------
// Pickers — every option the purchasing surfaces offer, resolved server-side
// ---------------------------------------------------------------------------

export type BranchOption = {
  id: string;
  code: string;
  name: string;
  city: string;
  defaultStockLocationId: string | null;
};

export type StockLocationOption = {
  id: string;
  branchId: string;
  code: string;
  name: string;
  kind: string;
  coldChain: boolean;
};

export type PackOption = {
  packLevelId: string;
  level: string;
  presentation: string;
  canonicalUnitsPerPack: number;
  /** "1 CARTON = 5 STRIPs = 50 units", ready to print beside the quantity field. */
  conversionLabel: string;
};

export type MedicineOption = {
  id: string;
  productName: string;
  brandName: string | null;
  coldChain: boolean;
  controlled: boolean;
  packs: PackOption[];
};

export type ApproverOption = { id: string; name: string | null; email: string };

export type PurchasingWorkspace = {
  branches: BranchOption[];
  stockLocations: StockLocationOption[];
  medicines: MedicineOption[];
  suppliers: SupplierSummary[];
  approvers: ApproverOption[];
  /** Procurement permission and branch access, independent of dispensing eligibility. */
  directPurchaseApprovers: (ApproverOption & { branchIds: string[] })[];
  soloApprovalAllowed?: boolean;
};

function conversionLabel(
  level: string,
  chain: readonly { level: string; unitsPerParent: number }[],
  units: number
) {
  if (chain.length <= 1) return `1 ${level} = ${units} units`;
  const steps: string[] = [];
  let running = 1;
  for (const step of chain.slice(1)) {
    running *= chain[steps.length]!.unitsPerParent;
    steps.push(`${running} ${step.level}${running === 1 ? '' : 's'}`);
  }
  return `1 ${level} = ${steps.join(' = ')} = ${units} units`;
}

/**
 * Everything the four consoles need to render a picker, in one round trip.
 *
 * `actorId` is excluded from the approver list on purpose: PUR-05 refuses a
 * bypass the receiver approved for themselves, and offering an option the
 * server will reject is UX rule 12's dead-end form.
 */
export async function purchasingWorkspace(
  db: ScopedDb,
  scope: OrganizationScope & { actorId?: string },
  options: { at?: Date } = {}
): Promise<PurchasingWorkspace> {
  const at = options.at ?? new Date();
  const solo = scope.actorId
    ? await soloOwnerEligible(db, { ...scope, actorId: scope.actorId })
    : false;
  const [branches, stockLocations, medicines, suppliers, approvers] = await Promise.all([
    db.pharmacyBranch.findMany({
      where: { organizationId: scope.organizationId, active: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, code: true, name: true, city: true, defaultStockLocationId: true },
    }),
    db.pharmacyStockLocation.findMany({
      where: { organizationId: scope.organizationId, active: true },
      orderBy: [{ branchId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        branchId: true,
        code: true,
        name: true,
        kind: true,
        coldChain: true,
      },
    }),
    db.medicine.findMany({
      where: { organizationId: scope.organizationId, saleable: true },
      orderBy: [{ productName: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        productName: true,
        brandName: true,
        coldChain: true,
        controlled: true,
        presentations: {
          orderBy: [{ presentation: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            presentation: true,
            packLevels: {
              select: {
                id: true,
                level: true,
                unitsPerParent: true,
                parentPackLevelId: true,
                effectiveFrom: true,
                effectiveTo: true,
              },
            },
          },
        },
      },
    }),
    listSuppliers(db, scope, { at }),
    db.user.findMany({
      where: {
        organizationId: scope.organizationId,
        status: 'ACTIVE',
        ...(scope.actorId && !solo ? { id: { not: scope.actorId } } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        organizationRole: {
          select: { permissions: { select: { capability: true, effect: true } } },
        },
        permissionOverrides: {
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
          select: { capability: true, effect: true },
        },
      },
    }),
  ]);

  const eligibleApprovers = [];
  const directPurchaseApprovers = [];
  for (const user of approvers) {
    if (await actorCanProcure(db, user.id, at)) {
      const branchIds = await assignedRegisterBranchIds(db, scope.organizationId, user.id);
      directPurchaseApprovers.push({ id: user.id, name: user.name, email: user.email, branchIds });
    }
    if (await can(subjectFromSession(user), 'pharmacy:dispense', undefined, { db, now: at })) {
      eligibleApprovers.push(user);
    }
  }
  return {
    branches,
    stockLocations,
    suppliers,
    soloApprovalAllowed: solo,
    directPurchaseApprovers,
    approvers: eligibleApprovers.map(({ id, name, email }) => ({ id, name, email })),
    medicines: medicines.map((medicine) => ({
      id: medicine.id,
      productName: medicine.productName,
      brandName: medicine.brandName,
      coldChain: medicine.coldChain,
      controlled: medicine.controlled,
      packs: medicine.presentations.flatMap((presentation) =>
        packConversions(presentation.packLevels as PackLevelNode[], at).map((conversion) => ({
          packLevelId: conversion.packLevelId,
          level: conversion.level,
          presentation: presentation.presentation,
          canonicalUnitsPerPack: conversion.canonicalUnitsPerPack,
          conversionLabel: conversionLabel(
            conversion.level,
            conversion.chain,
            conversion.canonicalUnitsPerPack
          ),
        }))
      ),
    })),
  };
}

// ---------------------------------------------------------------------------
// PUR-02 — requisitions, quotes, purchase orders
// ---------------------------------------------------------------------------

export async function listRequisitions(db: ScopedDb, scope: OrganizationScope) {
  return db.pharmacyRequisition.findMany({
    where: { organizationId: scope.organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      branch: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: { medicine: { select: { id: true, productName: true } } },
      },
      quotes: {
        orderBy: [{ quotedAt: 'desc' }, { id: 'desc' }],
        include: {
          supplier: { select: { id: true, name: true } },
          lines: { orderBy: { id: 'asc' } },
        },
      },
      purchaseOrders: { select: { id: true, reference: true, status: true } },
    },
  });
}

export type RequisitionDetail = Awaited<ReturnType<typeof listRequisitions>>[number];

export async function listPurchaseOrders(db: ScopedDb, scope: OrganizationScope) {
  return db.pharmacyPurchaseOrder.findMany({
    where: { organizationId: scope.organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      supplier: { select: { id: true, name: true, authorized: true } },
      branch: { select: { id: true, name: true } },
      requisition: { select: { id: true, reference: true, requestedByUserId: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          medicine: { select: { id: true, productName: true } },
          packLevel: { select: { id: true, level: true } },
        },
      },
      approvals: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      goodsReceipts: {
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, reference: true, status: true, receivedAt: true },
      },
    },
  });
}

export type PurchaseOrderDetail = Awaited<ReturnType<typeof listPurchaseOrders>>[number];

/**
 * PUR-02 — how much of each ordered line has actually arrived on a POSTED
 * receipt. Draft receipts are excluded: a document nobody has posted has not
 * delivered anything, and counting it would let the bench believe a line was
 * closed while the ledger still had no stock.
 */
export async function receivedAgainstOrder(
  db: ScopedDb,
  scope: OrganizationScope,
  purchaseOrderId: string
): Promise<Map<string, { receivedUnits: number; acceptedUnits: number; rejectedUnits: number }>> {
  const lines = await db.pharmacyGoodsReceiptLine.findMany({
    where: {
      organizationId: scope.organizationId,
      goodsReceipt: { organizationId: scope.organizationId, purchaseOrderId, status: 'POSTED' },
      purchaseOrderLineId: { not: null },
    },
    select: {
      purchaseOrderLineId: true,
      receivedCanonicalUnits: true,
      bonusCanonicalUnits: true,
      acceptedCanonicalUnits: true,
      rejectedCanonicalUnits: true,
    },
  });
  const totals = new Map<
    string,
    { receivedUnits: number; acceptedUnits: number; rejectedUnits: number }
  >();
  for (const line of lines) {
    const key = line.purchaseOrderLineId!;
    const running = totals.get(key) ?? { receivedUnits: 0, acceptedUnits: 0, rejectedUnits: 0 };
    running.receivedUnits += line.receivedCanonicalUnits + line.bonusCanonicalUnits;
    running.acceptedUnits += line.acceptedCanonicalUnits;
    running.rejectedUnits += line.rejectedCanonicalUnits;
    totals.set(key, running);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// PUR-02 receiving / PUR-04 exceptions / PUR-05 direct purchase
// ---------------------------------------------------------------------------

export async function listGoodsReceipts(db: ScopedDb, scope: BranchScope) {
  return db.pharmacyGoodsReceipt.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    include: {
      supplier: { select: { id: true, name: true } },
      purchaseOrder: { select: { id: true, reference: true, status: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          medicine: { select: { id: true, productName: true, controlled: true } },
          packLevel: { select: { id: true, level: true } },
          stockLocation: { select: { id: true, name: true } },
          quarantineLocation: { select: { id: true, name: true } },
        },
      },
      exceptions: { orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }] },
    },
  });
}

export type GoodsReceiptDetail = Awaited<ReturnType<typeof listGoodsReceipts>>[number];

/**
 * PUR-04 — the review queue, with enough context beside each row to act on it.
 * `listReceivingExceptions` in the goods-receipt service is the acceptance
 * query and returns bare rows; the console needs to say *which* medicine on
 * *which* receipt, so it joins rather than re-deciding anything.
 */
export async function listReceivingExceptionQueue(
  db: ScopedDb,
  scope: BranchScope,
  filter: { status?: 'OPEN' | 'RESOLVED' } = {}
) {
  return db.pharmacyReceivingException.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: filter.status ?? 'OPEN',
    },
    orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
    include: {
      goodsReceipt: {
        select: {
          id: true,
          reference: true,
          status: true,
          supplier: { select: { id: true, name: true } },
        },
      },
      goodsReceiptLine: {
        select: {
          id: true,
          lineNumber: true,
          batchNumber: true,
          medicine: { select: { id: true, productName: true } },
        },
      },
    },
  });
}

export type ReceivingExceptionRow = Awaited<ReturnType<typeof listReceivingExceptionQueue>>[number];

/**
 * PUR-02/PUR-04 — the stock a receipt actually produced, read back from the
 * PH-INV ledger rather than from the receipt document. This is the difference
 * between "we filed a receipt" and "the stock is visible", which is exactly the
 * distinction the acceptance walk turns on.
 */
export async function lotsFromReceipt(db: ScopedDb, scope: BranchScope, goodsReceiptId: string) {
  const lines = await db.pharmacyGoodsReceiptLine.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      goodsReceiptId,
      inventoryLotId: { not: null },
    },
    orderBy: { lineNumber: 'asc' },
    select: {
      lineNumber: true,
      batchNumber: true,
      medicine: { select: { id: true, productName: true } },
      inventoryLot: {
        select: {
          id: true,
          printedMrpMinor: true,
          unitCostMinor: true,
          unitsPerPack: true,
          receivedExpiresAt: true,
          batch: { select: { batchNumber: true, expiresAt: true, state: true } },
          balances: {
            select: { disposition: true, onHandUnits: true, location: { select: { name: true } } },
          },
        },
      },
    },
  });
  return lines.filter((line) => line.inventoryLot !== null);
}

// ---------------------------------------------------------------------------
// PUR-06 — returns, expiry claims and the credit position
// ---------------------------------------------------------------------------

export type ReturnWindowState = 'OPEN' | 'CLOSING' | 'CLOSED';

/**
 * PUR-06 — how much of the supplier's window is left. `assertReturnWindowOpen`
 * refuses a dispatch after the deadline, so a board that only said "open" would
 * hand the operator a submission that cannot be completed; CLOSING is the
 * seven-day warning that makes the deadline actionable while it still is.
 */
export function returnWindowState(returnWindowEndsAt: Date, at: Date): ReturnWindowState {
  const days = daysBetween(at, returnWindowEndsAt);
  if (days < 0) return 'CLOSED';
  return days <= 7 ? 'CLOSING' : 'OPEN';
}

/** Inclusive source dates; page omission preserves the existing array contract. */
export const purchasingReadBoundsSchema = z
  .object({
    from: z.date().optional(),
    to: z.date().optional(),
    page: z
      .object({
        limit: z.number().int().min(1).max(100).default(50),
        after: z
          .object({ at: z.date(), id: z.string().trim().min(1).max(128) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(({ from, to }) => !from || !to || from <= to, {
    message: 'From must be on or before To.',
    path: ['to'],
  });

export type PurchasingReadBounds = z.input<typeof purchasingReadBoundsSchema>;
export type PurchasingReadCursor = { at: Date; id: string };
export type PurchasingReadPage<T> = {
  rows: T[];
  /** Observation time only: dates filter documents, never reconstruct allocation history. */
  observedAt: Date;
  coverage: 'complete' | 'partial';
  cap: { limit: number; max: 100 };
  truncated: boolean;
  nextCursor: PurchasingReadCursor | null;
  bounds: { from: Date | null; to: Date | null };
  dateBasis: 'createdAt' | 'receivedAt';
  snapshot: 'live';
};
type ReadBounds = z.output<typeof purchasingReadBoundsSchema>;
type PagedBounds = PurchasingReadBounds & { page: NonNullable<PurchasingReadBounds['page']> };
type LegacyBounds = PurchasingReadBounds & { page?: undefined };

function readDateBounds(options: ReadBounds) {
  return options.from || options.to ? { gte: options.from, lte: options.to } : undefined;
}

function readPage<T>(
  rows: T[],
  options: ReadBounds,
  dateBasis: PurchasingReadPage<T>['dateBasis'],
  cursor: (row: T) => PurchasingReadCursor
): T[] | PurchasingReadPage<T> {
  if (!options.page) return rows;
  const { limit, after } = options.page;
  const truncated = rows.length > limit;
  const selected = rows.slice(0, limit);
  return {
    rows: selected,
    observedAt: new Date(),
    // A terminal later page does not include the earlier pages. No total/count query is implied.
    coverage: !after && !truncated ? 'complete' : 'partial',
    cap: { limit, max: 100 },
    truncated,
    nextCursor: truncated ? cursor(selected[selected.length - 1]!) : null,
    bounds: { from: options.from ?? null, to: options.to ?? null },
    dateBasis,
    snapshot: 'live',
  };
}

async function purchaseReturnRows(db: ScopedDb, scope: BranchScope, options: ReadBounds, at: Date) {
  const after = options.page?.after;
  const returns = await db.pharmacyPurchaseReturn.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdAt: readDateBounds(options),
      // Keyset predicates need no cursor lookup, including for foreign/deleted cursor IDs.
      ...(after
        ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
        : {}),
    },
    ...(options.page ? { take: options.page.limit + 1 } : {}),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      supplier: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          lot: {
            select: {
              id: true,
              unitCostMinor: true,
              receivedExpiresAt: true,
              batch: {
                select: {
                  batchNumber: true,
                  expiresAt: true,
                  medicine: { select: { id: true, productName: true } },
                },
              },
            },
          },
          location: { select: { id: true, name: true } },
        },
      },
      debitNotes: {
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        include: { allocations: true },
      },
    },
  });

  return returns.map((row) => ({
    ...row,
    lines: row.lines.map((line) => ({
      ...line,
      windowState: returnWindowState(line.returnWindowEndsAt, at),
      daysToWindowEnd: daysBetween(at, line.returnWindowEndsAt),
    })),
    debitNotes: row.debitNotes.map((note) => ({
      ...note,
      position: creditPosition({
        expectedCreditMinor: note.expectedCreditMinor,
        allocations: note.allocations,
        cancelled: note.status === 'CANCELLED',
      }),
    })),
    /** The soonest deadline on the document, which is the one that binds it. */
    earliestWindowEndsAt: row.lines.reduce<Date | null>(
      (soonest, line) =>
        soonest === null || line.returnWindowEndsAt < soonest ? line.returnWindowEndsAt : soonest,
      null
    ),
  }));
}

export type PurchaseReturnDetail = Awaited<ReturnType<typeof purchaseReturnRows>>[number];

export function listPurchaseReturns(
  db: ScopedDb,
  scope: BranchScope,
  options: PagedBounds & { at?: Date }
): Promise<PurchasingReadPage<PurchaseReturnDetail>>;
export function listPurchaseReturns(
  db: ScopedDb,
  scope: BranchScope,
  options?: LegacyBounds & { at?: Date }
): Promise<PurchaseReturnDetail[]>;
export function listPurchaseReturns(
  db: ScopedDb,
  scope: BranchScope,
  options: PurchasingReadBounds & { at?: Date }
): Promise<PurchaseReturnDetail[] | PurchasingReadPage<PurchaseReturnDetail>>;
export async function listPurchaseReturns(
  db: ScopedDb,
  scope: BranchScope,
  options: PurchasingReadBounds & { at?: Date } = {}
) {
  const { at, ...bounds } = options;
  const parsed = purchasingReadBoundsSchema.parse(bounds);
  const rows = await purchaseReturnRows(db, scope, parsed, at ?? new Date());
  return readPage(rows, parsed, 'createdAt', (row) => ({ at: row.createdAt, id: row.id }));
}

/**
 * PUR-06 — the lots a return can actually be raised against: on hand, in this
 * branch, with a quantity that is not already reserved by another claim.
 * Offering a lot the domain would refuse is UX rule 12's dead end.
 */
export async function listReturnableLots(db: ScopedDb, scope: BranchScope) {
  return db.pharmacyStockBalance.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      disposition: 'AVAILABLE',
      onHandUnits: { gt: 0 },
    },
    orderBy: [{ inventoryLotId: 'asc' }, { stockLocationId: 'asc' }],
    select: {
      onHandUnits: true,
      location: { select: { id: true, name: true } },
      lot: {
        select: {
          id: true,
          unitCostMinor: true,
          receivedExpiresAt: true,
          batch: {
            select: {
              batchNumber: true,
              expiresAt: true,
              medicine: { select: { id: true, productName: true } },
            },
          },
        },
      },
    },
  });
}

/**
 * PUR-02 receiving — what a scan or a typed search resolves to.
 *
 * A goods-in bench is operated with a barcode scanner, which is a keyboard: it
 * types a code and presses Enter. Resolving that code here means the bench can
 * jump straight to the line the carton belongs to instead of reading down an
 * order looking for it. A code that resolves to nothing is reported as such
 * rather than silently matching nothing — UX rule 9's error state.
 */
export type ScanResolution =
  | { kind: 'barcode'; medicineId: string; packLevelId: string | null; label: string }
  | {
      kind: 'gs1';
      medicineId: string | null;
      packLevelId: string | null;
      label: string;
      gtin: string;
      batch: string | null;
      expiryDate: string | null;
      rawExpiry: string | null;
      serial: string | null;
      warnings: readonly Gs1Warning[];
    }
  | { kind: 'medicine'; medicineId: string; packLevelId: null; label: string }
  | { kind: 'manual'; label: string; reason: string }
  | { kind: 'unresolved'; label: string };

async function barcodeForCodes(db: ScopedDb, scope: OrganizationScope, codes: string[]) {
  return db.medicineBarcode.findFirst({
    where: {
      organizationId: scope.organizationId,
      normalizedCode: { in: codes.map((code) => normalizeMedicineText(code)) },
      presentation: { medicine: { saleable: true } },
    },
    select: {
      packLevelId: true,
      presentation: { select: { medicineId: true, medicine: { select: { productName: true } } } },
    },
  });
}

export async function resolveScan(
  db: ScopedDb,
  scope: OrganizationScope,
  raw: string
): Promise<ScanResolution> {
  const term = raw.trim();
  if (!term) return { kind: 'unresolved', label: '' };

  const parsed = parseGs1DataMatrix(term);
  if (parsed.kind === 'invalid') return { kind: 'manual', label: term, reason: parsed.reason };
  if (parsed.kind === 'parsed') {
    const codes = [parsed.fields.gtin, parsed.fields.gtin13].filter((code): code is string =>
      Boolean(code)
    );
    const linked = await barcodeForCodes(db, scope, codes);
    return {
      kind: 'gs1',
      medicineId: linked?.presentation.medicineId ?? null,
      packLevelId: linked?.packLevelId ?? null,
      label: linked?.presentation.medicine.productName ?? parsed.fields.gtin,
      gtin: parsed.fields.gtin,
      batch: parsed.fields.batch,
      expiryDate: parsed.fields.expiryDate,
      rawExpiry: parsed.fields.expiry,
      serial: parsed.fields.serial,
      warnings: parsed.fields.warnings,
    };
  }

  const barcode = await db.medicineBarcode.findFirst({
    where: {
      organizationId: scope.organizationId,
      normalizedCode: normalizeMedicineText(term),
      presentation: { medicine: { saleable: true } },
    },
    select: {
      packLevelId: true,
      presentation: { select: { medicineId: true, medicine: { select: { productName: true } } } },
    },
  });
  if (barcode) {
    return {
      kind: 'barcode',
      medicineId: barcode.presentation.medicineId,
      packLevelId: barcode.packLevelId,
      label: barcode.presentation.medicine.productName,
    };
  }

  const medicine = await db.medicine.findFirst({
    where: {
      organizationId: scope.organizationId,
      saleable: true,
      productName: { contains: term, mode: 'insensitive' },
    },
    orderBy: [{ productName: 'asc' }, { id: 'asc' }],
    select: { id: true, productName: true },
  });
  if (medicine) {
    return {
      kind: 'medicine',
      medicineId: medicine.id,
      packLevelId: null,
      label: medicine.productName,
    };
  }
  return { kind: 'unresolved', label: term };
}

async function supplierCreditRows(db: ScopedDb, scope: BranchScope, options: ReadBounds) {
  const after = options.page?.after;
  return db.pharmacySupplierCredit.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      receivedAt: readDateBounds(options),
      ...(after
        ? { OR: [{ receivedAt: { lt: after.at } }, { receivedAt: after.at, id: { lt: after.id } }] }
        : {}),
    },
    ...(options.page ? { take: options.page.limit + 1 } : {}),
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    include: {
      supplier: { select: { id: true, name: true } },
      allocations: true,
    },
  });
}

export type SupplierCreditDetail = Awaited<ReturnType<typeof supplierCreditRows>>[number];
export function listSupplierCredits(
  db: ScopedDb,
  scope: BranchScope,
  options: PagedBounds
): Promise<PurchasingReadPage<SupplierCreditDetail>>;
export function listSupplierCredits(
  db: ScopedDb,
  scope: BranchScope,
  options?: LegacyBounds
): Promise<SupplierCreditDetail[]>;
export function listSupplierCredits(
  db: ScopedDb,
  scope: BranchScope,
  options: PurchasingReadBounds
): Promise<SupplierCreditDetail[] | PurchasingReadPage<SupplierCreditDetail>>;
export async function listSupplierCredits(
  db: ScopedDb,
  scope: BranchScope,
  options: PurchasingReadBounds = {}
) {
  const parsed = purchasingReadBoundsSchema.parse(options);
  const rows = await supplierCreditRows(db, scope, parsed);
  return readPage(rows, parsed, 'receivedAt', (row) => ({ at: row.receivedAt, id: row.id }));
}
