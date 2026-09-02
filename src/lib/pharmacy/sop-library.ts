import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  installSopPackDefinition,
  type InstallPackResult,
  type SopPack,
} from '@/lib/restaurant/sop-template-packs';

const daily = (dueTimeMinutes: number) => ({
  frequency: 'DAILY' as const,
  interval: 1,
  daysOfWeek: [],
  monthDay: null,
  dueTimeMinutes,
  windowMinutes: 1440,
  graceMinutes: 30,
});

export const PHARMACY_SOP_PACKS: readonly SopPack[] = [
  [
    'opening',
    'Pharmacy — opening',
    'Opening',
    8 * 60,
    [
      'Verify licence and qualified-person coverage',
      'Record fridge and ambient temperatures',
      'Confirm controlled register handover balance',
      'Open tills and inspect premises',
    ],
  ],
  [
    'closing',
    'Pharmacy — closing',
    'Closing',
    20 * 60,
    [
      'Reconcile controlled register and tills',
      'Secure prescriptions and controlled medicines',
      'Record final temperatures',
      'Lock premises and activate security',
    ],
  ],
  [
    'temperature-log',
    'Pharmacy — temperature log',
    'Storage',
    9 * 60,
    [
      'Record refrigerator temperature',
      'Record ambient storage temperature',
      'Document excursion and corrective action',
    ],
  ],
  [
    'controlled-counts',
    'Pharmacy — controlled counts',
    'Controlled medicines',
    10 * 60,
    [
      'Count controlled medicine stock',
      'Reconcile count to register balance',
      'Escalate and document any variance',
    ],
  ],
  [
    'expiry-pull',
    'Pharmacy — expiry pull',
    'Inventory',
    11 * 60,
    [
      'Review near-expiry stock',
      'Quarantine expired or damaged stock',
      'Record disposal or supplier-return action',
    ],
  ],
  [
    'receiving',
    'Pharmacy — receiving',
    'Receiving',
    12 * 60,
    [
      'Match delivery to approved purchase order',
      'Verify batch, expiry and warranty evidence',
      'Record cold-chain temperature and exceptions',
    ],
  ],
  [
    'hygiene',
    'Pharmacy — hygiene',
    'Hygiene',
    8 * 60 + 30,
    [
      'Inspect dispensary cleanliness',
      'Confirm hand-hygiene supplies',
      'Record cleaning completion and exceptions',
    ],
  ],
  [
    'incident-capa',
    'Pharmacy — incident and CAPA',
    'Quality',
    14 * 60,
    [
      'Record incident and immediate containment',
      'Identify root cause and corrective action',
      'Assign preventive action and verification',
    ],
  ],
  [
    'training-attestation',
    'Pharmacy — training attestation',
    'Training',
    15 * 60,
    [
      'Review assigned policy or procedure',
      'Confirm understanding',
      'Attest completion with signature',
    ],
  ],
].map(([key, name, category, due, steps]) => ({
  key: String(key),
  name: String(name),
  category: String(category),
  description: `${String(name)} checklist for pharmacy operations.`,
  defaultJobRoleKey: 'manager',
  suggestedRecurrence: daily(Number(due)),
  steps: (steps as string[]).map((title, index) => ({
    title,
    requiresNote: index === (steps as string[]).length - 1,
    requiresSignature: key === 'training-attestation' && index === 2,
  })),
}));

export async function installPharmacySopLibrary(
  db: ScopedDb,
  opts: { now?: Date } = {}
): Promise<InstallPackResult[]> {
  const results: InstallPackResult[] = [];
  for (const pack of PHARMACY_SOP_PACKS) {
    results.push(await installSopPackDefinition(db, pack, opts));
  }
  return results;
}
