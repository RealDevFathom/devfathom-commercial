/**
 * WHA-1196 — the constants the PH-PUR acceptance seed writes and the spec reads.
 *
 * Deliberately free of imports. Playwright loads spec files through a CommonJS
 * transform, and the generated Prisma client is ESM-only, so a spec that reached
 * these values through the seed module would fail to load before a single test
 * was collected.
 */

/** Disposable e2e-only login; override with PH_PUR_E2E_PASSWORD. Never a real credential. */
const E2E_PASSWORD = process.env.PH_PUR_E2E_PASSWORD ?? 'fake-e2e-only-password';

export const FIXTURE = {
  organizationSlug: 'ph-pur-e2e',
  organizationName: 'PH-PUR Acceptance Pharmacy',
  receiver: { email: 'receiver@ph-pur.test', name: 'Rabia Receiver', password: E2E_PASSWORD },
  approver: { email: 'approver@ph-pur.test', name: 'Adnan Approver', password: E2E_PASSWORD },
  branch: { code: 'MAIN', name: 'Saddar branch', city: 'Karachi' },
  shelf: { code: 'SHELF', name: 'Front shelf' },
  quarantine: { code: 'QUAR', name: 'Quarantine cage' },
  medicine: { productName: 'Amoxicillin 500mg capsule' },
  supplier: { name: 'Indus Pharma Distributors' },
  purchaseOrder: { reference: 'PO-E2E-1', orderedPacks: 10, unitsPerPack: 10 },
  /** Fewer packs than ordered, so posting raises a PUR-04 SHORTAGE. */
  delivery: { receivedPacks: 7, batchNumber: 'BATCH-E2E-77' },
  receipt: { reference: 'GRN-E2E-1', invoiceRef: 'INV-E2E-1', warrantyRef: 'WARRANTY-E2E-1' },
} as const;
