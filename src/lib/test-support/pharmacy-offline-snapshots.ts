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
