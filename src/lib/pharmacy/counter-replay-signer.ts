/** Browser-safe signing adapter for pharmacy counter replay.
 *
 * The enrolled device secret and terminal session remain in this in-memory
 * adapter. They are never added to the persisted counter queue. The byte input
 * deliberately mirrors `signPharmacyCommand` on the server.
 */
import type { TerminalScope } from '@/lib/retail-terminal/local-store';

import type { CounterReplaySigner } from './counter-offline-runtime';
import { canonicalJson } from './offline-snapshot-envelope';

const DOMAIN = 'pharmacy-offline-command:v1\n';

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Construct the production WebCrypto signer from credentials obtained during
 * counter establishment. Callers must keep the returned object in memory only.
 */
export function createCounterReplaySigner(
  scope: TerminalScope,
  credentials: { deviceSecret: string; terminalSession: string },
  cryptoProvider: Crypto = globalThis.crypto
): CounterReplaySigner {
  const encoder = new TextEncoder();
  let key: Promise<CryptoKey> | null = null;

  async function sign(payload: unknown): Promise<string> {
    key ??= cryptoProvider.subtle.importKey(
      'raw',
      encoder.encode(credentials.deviceSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const input =
      DOMAIN +
      canonicalJson({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: scope.deviceId,
        payload,
      });
    return hex(await cryptoProvider.subtle.sign('HMAC', await key, encoder.encode(input)));
  }

  return {
    async sign(input) {
      const [commandSignature, receiptSignature] = await Promise.all([
        sign(input.body),
        sign(input.leasedReceipt),
      ]);
      return {
        commandSignature,
        receiptSignature,
        authorization: `Bearer ${credentials.deviceSecret}`,
        terminalSession: credentials.terminalSession,
      };
    },
  };
}
