import { expect, it } from 'vitest';
import { buildApplePassJson } from '@/lib/restaurant/wallet/apple-pass';
import { buildLoyaltyObject } from '@/lib/restaurant/wallet/google';

const cardCode = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';
const serialNumber = 'wps_' + '0'.repeat(26);

it('carries the existing pharmacy code and signed ledger balance on both providers', () => {
  const apple = buildApplePassJson({
    credentials: { passTypeIdentifier: 'pass.test.local', teamIdentifier: 'TEST' },
    serialNumber,
    authenticationToken: 'wpa_' + '0'.repeat(26),
    alias: cardCode,
    balance: -3,
    programDisplayName: 'Local rewards',
    webServiceUrl: 'https://wallet.example.test',
  });
  const google = buildLoyaltyObject({
    issuerId: '1234567890123456789',
    classSuffix: 'wgc_' + '0'.repeat(26),
    serialNumber,
    alias: cardCode,
    balance: -3,
  });
  expect(apple.barcodes[0]?.message).toBe(cardCode);
  expect(apple.storeCard.primaryFields[0]?.value).toBe(-3);
  expect(google.barcode.value).toBe(cardCode);
  expect(google.loyaltyPoints.balance.int).toBe(-3);
});
