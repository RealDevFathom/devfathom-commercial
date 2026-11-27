import 'server-only';

import { buildApplePassJson, mintAppleAuthenticationToken } from './apple-pass';
import { buildLoyaltyObject } from './google';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export type VerifiedCard = {
  alias: string;
  balance: number;
  passes: { platform: 'APPLE' | 'GOOGLE'; serialNumber: string }[];
};
export type WalletFiles = {
  mode: 'TEST' | 'DEMO' | 'LIVE';
  googleUrl?: string;
  appleArchive?: string;
  apple?: object;
  google?: object;
};

export async function issueVerifiedWallet(
  organizationId: string,
  card: VerifiedCard
): Promise<WalletFiles> {
  const config = await withTenantDb(organizationId, (db) =>
    db.walletTenantConfig.findUnique({ where: { organizationId } })
  );
  if (!config?.enabled) throw new Error('Wallet programme unavailable.');
  const apple = card.passes.find((pass) => pass.platform === 'APPLE'),
    google = card.passes.find((pass) => pass.platform === 'GOOGLE');
  if (!apple || !google) throw new Error('Wallet passes unavailable.');
  const shared = { alias: card.alias, balance: card.balance };
  const pass = buildApplePassJson({
    ...shared,
    serialNumber: apple.serialNumber,
    programDisplayName: config.programDisplayName,
    credentials: {
      teamIdentifier: 'TEST000000',
      passTypeIdentifier: 'pass.test.devfathom.loyalty',
    },
    authenticationToken: mintAppleAuthenticationToken(),
    webServiceUrl: 'https://wallet.example.invalid',
    backgroundColor: config.backgroundColor,
    foregroundColor: config.foregroundColor,
  });
  const { authenticationToken: _token, webServiceURL: _service, ...unsigned } = pass;
  const object = buildLoyaltyObject({
    ...shared,
    issuerId: '0000000000000000000',
    classSuffix: config.googleClassSuffix,
    serialNumber: google.serialNumber,
  });
  return {
    mode: 'TEST',
    apple: {
      ...unsigned,
      logoText: config.programDisplayName,
      description: config.programDisplayName + ' (TEST)',
      storeCard: {
        ...pass.storeCard,
        headerFields: [{ key: 'mode', label: 'Mode', value: 'TEST' }],
      },
    },
    google: {
      ...object,
      id: 'test-issuer.' + google.serialNumber,
      classId: 'test-issuer.' + config.googleClassSuffix,
      loyaltyPoints: { ...object.loyaltyPoints, label: 'Points (TEST)' },
    },
  };
}
