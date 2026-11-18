import 'server-only';

import { randomBytes } from 'node:crypto';

import { LOYALTY_POINT_VALUE_MINOR } from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { customerPointsBalance } from './customer-loyalty';
import { formatLoyaltyCardCode, normalizeLoyaltyCardCode } from './loyalty-card-code';
import { currentLoyaltyProgram } from './loyalty-program';

/**
 * DEV-747: Apple Wallet and Google Wallet loyalty passes, in TEST mode only.
 *
 * A wallet pass is another way to carry the customer's loyalty card: its QR holds the same
 * opaque card code as the printed card, so the counter scan, the organization-wide points
 * balance, replacement and revocation are all the card's own. Nothing here is a new account
 * or a new balance: the ledger stays the only source of truth, and the balance on a pass is
 * what the ledger said when the card was issued.
 *
 * Live passes wait for Pakistan issuer eligibility, company issuer accounts and agreements,
 * secure credentials and a real-device pass (see docs/pharmacy/loyalty-wallet-passes.md).
 * Until then every pass built here is unsigned, carries only placeholder test issuer
 * identifiers, and says on its face that it is a test pass. No issuer credential is read,
 * stored or needed.
 *
 * Privacy: the pass carries the card code, the points balance and the point value, and
 * nothing else about the customer: no name, phone, purchase, medicine or health data, and no
 * internal id (the serial is random).
 */
export const PHARMACY_WALLET_PASS_MODE = 'TEST' as const;

/** Placeholder issuer identifiers. They name no real Apple or Google account. */
export const PHARMACY_WALLET_TEST_ISSUER = {
  applePassTypeIdentifier: 'pass.test.devfathom.pharmacy-loyalty',
  appleTeamIdentifier: 'TEST000000',
  googleIssuerId: 'test-issuer',
  googleClassId: 'test-issuer.pharmacy_loyalty',
} as const;

export const PHARMACY_WALLET_TEST_NOTICE =
  'Test pass: not signed by an issuer, so a phone Wallet will not accept it. Its QR works at the counter.';

const SERIAL_PATTERN = /^plw_[0-9a-f]{32}$/;
const MAX_POINTS = 2_147_483_647;

export function mintPharmacyWalletSerial(random: (size: number) => Buffer = randomBytes) {
  return `plw_${random(16).toString('hex')}`;
}

function rupees(minor: number) {
  const whole = minor / 100;
  return `PKR ${Number.isInteger(whole) ? whole.toLocaleString('en-US') : whole.toFixed(2)}`;
}

export type PharmacyWalletTestPassInput = {
  code: string;
  serialNumber: string;
  balancePoints: number;
  pointValueMinor: number;
};

/** Apple's pass.json for a store card. Unsigned: there is no manifest, signature or web service. */
export type PharmacyAppleTestPass = {
  formatVersion: 1;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: 'DevFathom';
  description: string;
  logoText: string;
  storeCard: {
    headerFields: { key: 'mode'; label: string; value: string }[];
    primaryFields: { key: 'balance'; label: string; value: number }[];
    secondaryFields: { key: 'value'; label: string; value: string }[];
    backFields: { key: 'notice'; label: string; value: string }[];
  };
  barcodes: {
    format: 'PKBarcodeFormatQR';
    message: string;
    messageEncoding: 'iso-8859-1';
    altText: string;
  }[];
};

/** A Google Wallet LoyaltyObject, as it would be sent in a save JWT. Never signed or sent. */
export type PharmacyGoogleTestPass = {
  id: string;
  classId: string;
  state: 'ACTIVE';
  loyaltyPoints: { label: string; balance: { int: number } };
  barcode: { type: 'QR_CODE'; value: string; alternateText: string };
  textModulesData: { id: 'value' | 'notice'; header: string; body: string }[];
};

export type PharmacyWalletTestPasses = {
  mode: typeof PHARMACY_WALLET_PASS_MODE;
  notice: string;
  balancePoints: number;
  pointValueMinor: number;
  apple: PharmacyAppleTestPass;
  google: PharmacyGoogleTestPass;
};

/**
 * Builds both test passes from plain values. Refuses anything that is not a card code, a
 * random serial, a whole points balance or a valid point value, so nothing else can reach a
 * pass by mistake.
 */
export function buildPharmacyWalletTestPasses(
  input: PharmacyWalletTestPassInput
): PharmacyWalletTestPasses {
  const code = normalizeLoyaltyCardCode(input.code);
  if (!code || code !== input.code) throw new Error('Invalid loyalty card code for a wallet pass.');
  if (!SERIAL_PATTERN.test(input.serialNumber))
    throw new Error('Invalid wallet pass serial number.');
  if (!Number.isSafeInteger(input.balancePoints) || Math.abs(input.balancePoints) > MAX_POINTS)
    throw new Error('Invalid wallet pass balance.');
  if (!Number.isSafeInteger(input.pointValueMinor) || input.pointValueMinor < 1)
    throw new Error('Invalid wallet pass point value.');
  const altText = formatLoyaltyCardCode(code);
  const pointValue = `1 point = ${rupees(input.pointValueMinor)}`;
  const issuer = PHARMACY_WALLET_TEST_ISSUER;
  return {
    mode: PHARMACY_WALLET_PASS_MODE,
    notice: PHARMACY_WALLET_TEST_NOTICE,
    balancePoints: input.balancePoints,
    pointValueMinor: input.pointValueMinor,
    apple: {
      formatVersion: 1,
      passTypeIdentifier: issuer.applePassTypeIdentifier,
      teamIdentifier: issuer.appleTeamIdentifier,
      serialNumber: input.serialNumber,
      organizationName: 'DevFathom',
      description: 'Pharmacy loyalty card (test pass)',
      logoText: 'Loyalty card',
      storeCard: {
        headerFields: [{ key: 'mode', label: 'Pass', value: 'TEST' }],
        primaryFields: [{ key: 'balance', label: 'Points', value: input.balancePoints }],
        secondaryFields: [{ key: 'value', label: 'Point value', value: pointValue }],
        backFields: [{ key: 'notice', label: 'Test pass', value: PHARMACY_WALLET_TEST_NOTICE }],
      },
      barcodes: [
        { format: 'PKBarcodeFormatQR', message: code, messageEncoding: 'iso-8859-1', altText },
      ],
    },
    google: {
      id: `${issuer.googleIssuerId}.${input.serialNumber}`,
      classId: issuer.googleClassId,
      state: 'ACTIVE',
      loyaltyPoints: { label: 'Points', balance: { int: input.balancePoints } },
      barcode: { type: 'QR_CODE', value: code, alternateText: altText },
      textModulesData: [
        { id: 'value', header: 'Point value', body: pointValue },
        { id: 'notice', header: 'Test pass', body: PHARMACY_WALLET_TEST_NOTICE },
      ],
    },
  };
}

/**
 * The test passes for a card just issued, in the issuing transaction: the balance is the
 * customer's organization-wide ledger balance and the point value is the owner's current
 * redemption value (PKR 1 when no program is set).
 */
export async function issuePharmacyWalletTestPasses(
  db: ScopedDb,
  organizationId: string,
  input: { customerId: string; code: string }
) {
  // One after the other: the balance read briefly unbinds the branch on this connection.
  const balancePoints = await customerPointsBalance(db, organizationId, input.customerId);
  const program = await currentLoyaltyProgram(db, organizationId);
  return buildPharmacyWalletTestPasses({
    code: input.code,
    serialNumber: mintPharmacyWalletSerial(),
    balancePoints,
    pointValueMinor: program?.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR,
  });
}
