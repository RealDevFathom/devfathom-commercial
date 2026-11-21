/**
 * DEV-957 phase 1: the browser half of the offline command MAC.
 *
 * The server authenticates every replayed command and its leased receipt with
 * `signPharmacyCommand` (src/lib/pharmacy/sales.ts): HMAC-SHA256 keyed by the
 * UTF-8 bytes of the raw `pcd_…` device secret, over the UTF-8 bytes of
 * `pharmacy-offline-command:v1\n` followed by the canonical JSON of
 * `{ organizationId, branchId, deviceId, payload }`. This module computes the
 * same bytes with WebCrypto, so a counter can sign offline.
 *
 * The secret is imported ONCE, at enrolment, into a NON-EXTRACTABLE CryptoKey:
 * after that no script on the page (including this one) can read the secret
 * back out of the key. The string itself is dropped by the caller and is never
 * written anywhere. Client-safe: no Node imports.
 */
import type {
  CounterReplaySignatures,
  CounterReplaySigner,
} from './counter-command-queue';
import { canonicalJson } from './offline-snapshot-envelope';
import type { OfflineSaleSealer, SealDigest } from './offline-sale-seal';

export const PHARMACY_COMMAND_SIGNING_DOMAIN = 'pharmacy-offline-command:v1\n';
const SECRET_FORMAT = /^pcd_[A-Za-z0-9_-]{43}$/;

export type CounterSigningScope = { organizationId: string; branchId: string };

function subtleCrypto(subtle?: SubtleCrypto): SubtleCrypto {
  const resolved = subtle ?? globalThis.crypto?.subtle;
  if (!resolved) throw new Error('This browser cannot sign counter sales (no WebCrypto).');
  return resolved;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

/** Import the enrolment secret into a key that can sign but can never be exported. */
export async function importCounterSigningKey(
  secret: string,
  subtle?: SubtleCrypto
): Promise<CryptoKey> {
  if (!SECRET_FORMAT.test(secret)) throw new Error('This is not a pharmacy counter credential.');
  return subtleCrypto(subtle).importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/** The exact message `signPharmacyCommand` MACs, as UTF-8 bytes. */
export function counterCommandSigningInput(
  scope: CounterSigningScope,
  deviceId: string,
  payload: unknown
): Uint8Array {
  return new TextEncoder().encode(
    PHARMACY_COMMAND_SIGNING_DOMAIN +
      canonicalJson({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId,
        payload,
      })
  );
}

/** Lowercase hex HMAC-SHA256, byte for byte what the server recomputes. */
export async function signCounterCommand(
  key: CryptoKey,
  scope: CounterSigningScope,
  deviceId: string,
  payload: unknown,
  subtle?: SubtleCrypto
): Promise<string> {
  const message = counterCommandSigningInput(scope, deviceId, payload);
  return hex(
    await subtleCrypto(subtle).sign('HMAC', key, message.buffer.slice(0) as ArrayBuffer)
  );
}

/** The runtime's replay signer: the command body and its leased receipt, one key. */
export function counterReplaySigner(
  key: CryptoKey,
  scope: CounterSigningScope,
  deviceId: string,
  subtle?: SubtleCrypto
): CounterReplaySigner {
  return async (body, leasedReceipt): Promise<CounterReplaySignatures> => ({
    command: await signCounterCommand(key, scope, deviceId, body, subtle),
    receipt: await signCounterCommand(key, scope, deviceId, leasedReceipt, subtle),
  });
}

/**
 * DEV-957 phase 2 (hardening 4): seal a sale at the moment it is taken. The SHA-256 hash
 * chains it to the next sale; the HMAC under the same non-extractable key proves it.
 * Byte for byte what `offline-sale-seal-node.ts` recomputes on the server.
 */
export function counterSaleSealer(key: CryptoKey, subtle?: SubtleCrypto): OfflineSaleSealer {
  return async (message: string): Promise<SealDigest> => {
    const bytes = new TextEncoder().encode(message);
    const crypto = subtleCrypto(subtle);
    const buffer = bytes.buffer.slice(0) as ArrayBuffer;
    return {
      hash: hex(await crypto.digest('SHA-256', buffer)),
      signature: hex(await crypto.sign('HMAC', key, buffer)),
    };
  };
}
