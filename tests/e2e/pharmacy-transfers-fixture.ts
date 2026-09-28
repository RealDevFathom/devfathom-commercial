/**
 * WHA-1603 — the constants the INV-07 transfers seed writes and the spec reads.
 *
 * Import-free for the same reason as the PH-PUR fixture: Playwright loads specs
 * through a CommonJS transform and the generated Prisma client is ESM-only.
 */
export const TRANSFERS_FIXTURE = {
  organizationSlug: 'ph-xfer-e2e',
  organizationName: 'PH-XFER Acceptance Pharmacy',
  /** Allocates, dispatches and receives — the everyday chain operator. */
  dispatcher: {
    email: 'dispatcher@ph-xfer.test',
    name: 'Rabia Dispatcher',
    password: 'PhXferBench!2026',
  },
  /** INV-07 approval needs somebody else; the same person witnesses the shortfall. */
  approver: {
    email: 'approver@ph-xfer.test',
    name: 'Adnan Approver',
    password: 'PhXferBench!2026',
  },
  source: {
    code: 'SADDAR',
    name: 'Saddar branch',
    city: 'Karachi',
    location: { code: 'SHELF', name: 'Front shelf' },
  },
  destination: {
    code: 'CLIFTON',
    name: 'Clifton branch',
    city: 'Karachi',
    location: { code: 'STORE', name: 'Back store' },
  },
  medicine: { productName: 'Amoxicillin 500mg capsule', unitsPerPack: 10 },
  /** Seeded on the source shelf, run-unique batch so reruns never share a lot. */
  openingUnits: 100,
  transfer: { units: 30, receivedUnits: 20 },
} as const;

export const TRANSFERS_ARTIFACTS = 'playwright-artifacts/pharmacy-transfers-fixture';
