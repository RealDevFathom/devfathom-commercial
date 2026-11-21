/**
 * DEV-957 phase 2 (review hardening 4): the server half of the offline sale seal
 * (`offline-sale-seal.ts`), on node:crypto. The seal is HMAC-SHA256 under the device
 * secret over the seal message, and the chain hash is SHA-256 of the same message, so
 * the browser's WebCrypto seal and this one agree byte for byte.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  offlineSaleSealMessage,
  sealOperatorOf,
  type OfflineSaleSeal,
  type OfflineSaleSealScope,
  type SealableSale,
  type SealDigest,
} from './offline-sale-seal';

export function sealMessageHash(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

export function nodeSealDigest(message: string, deviceSecret: string): SealDigest {
  return {
    hash: sealMessageHash(message),
    signature: createHmac('sha256', deviceSecret).update(message, 'utf8').digest('hex'),
  };
}

/** The chain hash of a sale as it was recorded (no secret needed), or null without a seal. */
export function recordedSaleSealHash(
  scope: OfflineSaleSealScope,
  sale: SealableSale & { seal?: Pick<OfflineSaleSeal, 'previousHash' | 'lineTotalsMinor'> | null }
): string | null {
  if (!sale.seal) return null;
  return sealMessageHash(offlineSaleSealMessage(scope, sale, sale.seal, sealOperatorOf(sale)));
}

/** True when the seal's signature is this device secret's MAC over this exact sale. */
export function offlineSaleSealValid(
  scope: OfflineSaleSealScope,
  sale: SealableSale,
  seal: OfflineSaleSeal,
  deviceSecret: string
): boolean {
  if (!/^[0-9a-f]{64}$/.test(seal.signature)) return false;
  const expected = nodeSealDigest(
    offlineSaleSealMessage(scope, sale, seal, sealOperatorOf(sale)),
    deviceSecret
  ).signature;
  return timingSafeEqual(Buffer.from(seal.signature, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Seal a replay body the way a counter does at the moment of sale. For server tests and
 * tools that compose replays; the counter itself seals in the browser.
 */
export function sealOfflineSale(
  scope: OfflineSaleSealScope,
  sale: SealableSale,
  input: { previousHash: string | null; lineTotalsMinor: readonly number[] },
  deviceSecret: string
): { seal: OfflineSaleSeal; hash: string } {
  const message = offlineSaleSealMessage(scope, sale, input, sealOperatorOf(sale));
  const digest = nodeSealDigest(message, deviceSecret);
  return {
    seal: {
      previousHash: input.previousHash,
      lineTotalsMinor: [...input.lineTotalsMinor],
      signature: digest.signature,
    },
    hash: digest.hash,
  };
}
