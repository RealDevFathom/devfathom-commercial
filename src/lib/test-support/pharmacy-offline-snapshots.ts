/**
 * DEV-957 test support: snapshots signed by the REAL server signer
 * (offline-snapshots.ts, Ed25519 from PLATFORM_ENCRYPTION_KEY), so the browser
 * verifier is tested against exactly what the server issues.
 */
import { randomBytes } from 'node:crypto';

import {
  signSnapshotEnvelope,
  snapshotPayloadHash,
  snapshotPublicKey,
  SNAPSHOT_SIGNING_KEY_ID,
} from '@/lib/pharmacy/offline-snapshots';
import type { PharmacyOfflineSnapshotKind } from '@/lib/pharmacy/offline-action-matrix';
import type { OfflineSnapshotEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

export const FIXTURE_SCOPE = {
  organizationId: 'org_offline_fixture',
  branchId: 'branch_offline_fixture',
  deviceId: 'device_offline_fixture',
};

export function fixturePublicKey(): string {
  return snapshotPublicKey();
}

export function signedSnapshot(
  kind: PharmacyOfflineSnapshotKind,
  payload: unknown,
  options: {
    version?: number;
    issuedAt?: Date;
    hours?: number;
    recalledBatchIds?: string[];
    scope?: typeof FIXTURE_SCOPE;
  } = {}
) {
  const issuedAt = options.issuedAt ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + (options.hours ?? 8) * 3_600_000);
  const envelope: OfflineSnapshotEnvelope = {
    ...(options.scope ?? FIXTURE_SCOPE),
    kind,
    version: options.version ?? 1,
    payloadHash: snapshotPayloadHash(payload),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    safetyLease: {
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      recallVersion: 0,
      licenceVersion: 0,
      ruleVersion: 0,
      recalledBatchIds: options.recalledBatchIds ?? [],
    },
    signingKeyId: SNAPSHOT_SIGNING_KEY_ID,
  };
  return { envelope, signature: signSnapshotEnvelope(envelope), payload };
}

/** A tiny shop: two OTC medicines, three lots, one quota each. */
export function fixturePayloads() {
  const CATALOG = [
    {
      id: 'med_panadol',
      productName: 'Panadol 500mg',
      presentations: [
        { id: 'pres_panadol', presentation: 'Tablet', packLevels: [{ id: 'pack_panadol' }] },
      ],
    },
    {
      id: 'med_ors',
      productName: 'ORS sachet',
      presentations: [{ id: 'pres_ors', presentation: 'Sachet', packLevels: [{ id: 'pack_ors' }] }],
    },
  ];
  const PRICES = [
    {
      id: 'lot_panadol_a',
      manufacturingBatchId: 'batch_a',
      packLevelId: 'pack_panadol',
      unitsPerPack: 10,
      printedMrpMinor: 3_500,
      receivedExpiresAt: '2030-01-31T00:00:00.000Z',
    },
    {
      id: 'lot_ors_recalled',
      manufacturingBatchId: 'batch_b',
      packLevelId: 'pack_ors',
      unitsPerPack: 1,
      printedMrpMinor: 4_000,
      receivedExpiresAt: '2030-01-31T00:00:00.000Z',
    },
    {
      id: 'lot_rx_only',
      manufacturingBatchId: 'batch_c',
      packLevelId: 'pack_not_in_catalogue',
      unitsPerPack: 14,
      printedMrpMinor: 90_000,
      receivedExpiresAt: '2030-01-31T00:00:00.000Z',
    },
  ];
  const LOT_BALANCES = [
    { inventoryLotId: 'lot_panadol_a', stockLocationId: 'loc_front', quotaUnits: 20, consumedUnits: 0 },
    { inventoryLotId: 'lot_ors_recalled', stockLocationId: 'loc_front', quotaUnits: 5, consumedUnits: 0 },
    { inventoryLotId: 'lot_rx_only', stockLocationId: 'loc_front', quotaUnits: 5, consumedUnits: 0 },
  ];
  const RULES = { controlledMedicinesPermittedOffline: false, rxPermittedOffline: false };
  return { CATALOG, PRICES, TAX: [], RULES, LOT_BALANCES };
}

/**
 * DEV-957 phase 2: a shop the counter can SELL from offline. A box of 3 strips of 7
 * tablets (21 per pack, an odd count; each level's unitsPerParent counts it inside its parent) with a rounding rule of 5 paisa, a 10-tablet strip
 * received as its own pack, and the cashier the RULES snapshot names.
 */
export function fixtureSalePayloads(
  options: { operator?: { userId: string; name: string | null }; quotaUnits?: number } = {}
) {
  const levels = (prefix: string, created: string) => ({
    box: {
      id: `${prefix}_box`,
      level: 'BOX',
      parentPackLevelId: null,
      unitsPerParent: 1,
      effectiveFrom: created,
      effectiveTo: null,
    },
    strip: {
      id: `${prefix}_strip`,
      level: 'STRIP',
      parentPackLevelId: `${prefix}_box`,
      unitsPerParent: 3,
      effectiveFrom: created,
      effectiveTo: null,
    },
    unit: {
      id: `${prefix}_unit`,
      level: 'UNIT',
      parentPackLevelId: `${prefix}_strip`,
      unitsPerParent: 7,
      effectiveFrom: created,
      effectiveTo: null,
    },
  });
  const brufen = levels('pack_brufen', '2026-01-01T00:00:00.000Z');
  const CATALOG = [
    {
      id: 'med_brufen',
      productName: 'Brufen 400mg',
      presentations: [
        {
          id: 'pres_brufen',
          presentation: 'Tablet, 3 x 7',
          dosageForm: 'TABLET',
          packLevels: [brufen.box, brufen.strip, brufen.unit],
        },
      ],
    },
    {
      id: 'med_panadol',
      productName: 'Panadol 500mg',
      presentations: [
        {
          id: 'pres_panadol',
          presentation: 'Tablet, 10 per strip',
          dosageForm: 'TABLET',
          packLevels: [
            {
              id: 'pack_panadol',
              level: 'STRIP',
              parentPackLevelId: null,
              unitsPerParent: 10,
              effectiveFrom: '2026-01-01T00:00:00.000Z',
              effectiveTo: null,
            },
          ],
        },
      ],
    },
  ];
  const PRICES = [
    {
      id: 'lot_brufen',
      manufacturingBatchId: 'batch_brufen',
      packLevelId: 'pack_brufen_box',
      unitsPerPack: 21,
      printedMrpMinor: 1_000,
      receivedExpiresAt: '2030-01-31T00:00:00.000Z',
      roundingIncrementMinor: 5,
      batchNumber: 'BR-01',
    },
    {
      id: 'lot_panadol_a',
      manufacturingBatchId: 'batch_a',
      packLevelId: 'pack_panadol',
      unitsPerPack: 10,
      printedMrpMinor: 3_500,
      receivedExpiresAt: '2030-01-31T00:00:00.000Z',
      roundingIncrementMinor: 1,
      batchNumber: 'PN-07',
    },
  ];
  const units = options.quotaUnits ?? 20;
  const LOT_BALANCES = [
    { inventoryLotId: 'lot_brufen', stockLocationId: 'loc_front', quotaUnits: units, consumedUnits: 0 },
    { inventoryLotId: 'lot_panadol_a', stockLocationId: 'loc_front', quotaUnits: units, consumedUnits: 0 },
  ];
  const RULES = {
    controlledMedicinesPermittedOffline: false,
    rxPermittedOffline: false,
    manualMerchantPolicies: {},
    manualMerchantRevision: 0,
    operator: options.operator ?? { userId: 'user_cashier_a', name: 'Ayesha Khan' },
    branchName: 'Gulberg branch',
  };
  return { CATALOG, PRICES, TAX: [], RULES, LOT_BALANCES };
}
