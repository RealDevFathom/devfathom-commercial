import 'server-only';

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildApplePassJson,
  buildPkpass,
  hashAppleAuthenticationToken,
  mintAppleAuthenticationToken,
} from './apple-pass';
import {
  buildLoyaltyObject,
  buildSaveToWalletUrl,
  createGoogleWalletClient,
  type GoogleWalletTransport,
} from './google';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { walletRuntime, type WalletRuntime } from './modes';
import { tenantHostUrl } from '@/lib/tenancy/host-routing';

export type VerifiedCard = {
  alias: string;
  balance: number;
  phone?: string;
  passes: { platform: 'APPLE' | 'GOOGLE'; serialNumber: string }[];
};
export type WalletFiles = {
  mode: 'TEST' | 'DEMO' | 'LIVE';
  googleUrl?: string;
  appleArchive?: string;
  apple?: object;
  google?: object;
};
type Design = {
  updatedAt?: Date;
  programDisplayName: string;
  googleClassSuffix: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  logoPng: Uint8Array | null;
};
type BuildInput = {
  card: VerifiedCard;
  design: Design;
  runtime: WalletRuntime;
  origin: string;
  phone?: string;
  transport?: GoogleWalletTransport;
};

export async function appleAssets(logo: Uint8Array | null) {
  const icon = await readFile(join(process.cwd(), 'public/favicon.png'));
  return { 'icon.png': icon, 'logo.png': logo ? Buffer.from(logo) : icon };
}

export async function buildWalletFiles({
  card,
  design,
  runtime,
  origin,
  phone,
  transport,
}: BuildInput) {
  if (runtime.mode === 'DEMO' && (!phone || !runtime.demoPhones?.includes(phone)))
    throw new Error('A Google Wallet test account is required.');
  const apple = card.passes.find((p) => p.platform === 'APPLE'),
    google = card.passes.find((p) => p.platform === 'GOOGLE');
  if (!apple || !google) throw new Error('Wallet passes unavailable.');
  const shared = { alias: card.alias, balance: card.balance };
  const object = buildLoyaltyObject({
    ...shared,
    issuerId: runtime.google?.issuerId ?? '0000000000000000000',
    classSuffix: design.googleClassSuffix,
    serialNumber: google.serialNumber,
  });
  const files: WalletFiles = { mode: runtime.mode };
  let appleHash: string | undefined;
  if (runtime.mode === 'TEST' || runtime.apple) {
    // Re-adding the same pass on another device preserves the first device's token.
    // The pharmacy device supplies its own barcode on refresh; storage holds only the token hash.
    const token = runtime.tokenKey
      ? mintAppleAuthenticationToken(
          createHmac('sha256', runtime.tokenKey)
            .update('wallet-pass:' + apple.serialNumber)
            .digest()
            .subarray(0, 16)
        ) + (card.alias.startsWith('DFLC') ? '.' + card.alias : '')
      : mintAppleAuthenticationToken();
    const pass = buildApplePassJson({
      ...shared,
      serialNumber: apple.serialNumber,
      programDisplayName: design.programDisplayName,
      credentials: runtime.apple ?? {
        teamIdentifier: 'TEST000000',
        passTypeIdentifier: 'pass.test.devfathom.loyalty',
      },
      authenticationToken: token,
      webServiceUrl: runtime.apple
        ? new URL(
            '/api/wallet/apple',
            process.env.PLATFORM_BASE_DOMAIN
              ? 'https://wallet.' + process.env.PLATFORM_BASE_DOMAIN
              : origin
          ).href
        : 'https://wallet.example.invalid',
      backgroundColor: design.backgroundColor,
      foregroundColor: design.foregroundColor,
    });
    if (runtime.apple) {
      files.appleArchive = buildPkpass(
        { ...pass, logoText: design.programDisplayName },
        runtime.apple,
        await appleAssets(design.logoPng)
      ).toString('base64');
      appleHash = hashAppleAuthenticationToken(token);
    } else {
      files.apple = {
        formatVersion: pass.formatVersion,
        organizationName: pass.organizationName,
        passTypeIdentifier: pass.passTypeIdentifier,
        teamIdentifier: pass.teamIdentifier,
        serialNumber: pass.serialNumber,
        backgroundColor: pass.backgroundColor,
        foregroundColor: pass.foregroundColor,
        barcodes: pass.barcodes,
        logoText: design.programDisplayName,
        description: design.programDisplayName + ' (TEST)',
        storeCard: {
          ...pass.storeCard,
          headerFields: [{ key: 'mode', label: 'Mode', value: 'TEST' }],
        },
      };
    }
  }
  if (runtime.google) {
    const client = createGoogleWalletClient({ credentials: runtime.google, transport });
    const logoUrl = new URL('/api/wallet/logo/' + design.googleClassSuffix, origin);
    if (design.updatedAt) logoUrl.searchParams.set('v', String(design.updatedAt.getTime()));
    const logoUri = logoUrl.href;
    await client.ensureLoyaltyClass({
      classSuffix: design.googleClassSuffix,
      brand: {
        programDisplayName: design.programDisplayName,
        backgroundColor: design.backgroundColor,
        logoUri,
      },
      refreshBrand: true,
    });
    await client.ensureLoyaltyObject({
      ...shared,
      classSuffix: design.googleClassSuffix,
      serialNumber: google.serialNumber,
    });
    files.googleUrl = buildSaveToWalletUrl({ credentials: runtime.google, loyaltyObject: object });
  } else if (runtime.mode === 'TEST') {
    files.google = {
      ...object,
      id: 'test-issuer.' + google.serialNumber,
      classId: 'test-issuer.' + design.googleClassSuffix,
      loyaltyPoints: { ...object.loyaltyPoints, label: 'Points (TEST)' },
    };
  }
  return { files, appleHash };
}

export class WalletProviderUnavailable extends Error {}
export class WalletDemoAccountRequired extends Error {}

export async function issueVerifiedWallet(organizationId: string, card: VerifiedCard) {
  const runtime = walletRuntime();
  if (runtime.mode === 'DEMO' && (!card.phone || !runtime.demoPhones?.includes(card.phone))) {
    throw new WalletDemoAccountRequired('A Google Wallet test account is required.');
  }
  const serials = card.passes.map((pass) => pass.serialNumber);
  const active = { organizationId, status: 'ACTIVE' as const, serialNumber: { in: serials } };
  const context = await withTenantDb(organizationId, async (db) => {
    const config = await db.walletTenantConfig.findUnique({ where: { organizationId } });
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true },
    });
    if (!org || !config?.enabled) throw new Error('Wallet programme unavailable.');
    const origin =
      tenantHostUrl(org.slug, '/') ??
      (runtime.mode === 'TEST' ? 'https://wallet.example.invalid' : null);
    if (!origin) throw new Error('Issuer origin unavailable.');
    if ((await db.walletPass.count({ where: active })) !== serials.length)
      throw new Error('Wallet pass is no longer active.');
    if (runtime.mode !== 'TEST') {
      for (const pass of card.passes) {
        if (pass.platform === 'APPLE' ? !runtime.apple : !runtime.google) continue;
        const marked = await db.walletPass.updateMany({
          where: { ...active, serialNumber: pass.serialNumber },
          data: { issuerMode: runtime.mode },
        });
        if (marked.count !== 1) throw new Error('Wallet pass is no longer active.');
      }
    }
    return { design: config, origin };
  });
  const { files, appleHash } = await buildWalletFiles({
    card,
    ...context,
    runtime,
    phone: card.phone,
  }).catch(() => {
    throw new WalletProviderUnavailable('Wallet issuance is unavailable.');
  });
  const ready = await withTenantDb(organizationId, async (db) => {
    const enabled = await db.walletTenantConfig.findFirst({
      where: { organizationId, enabled: true },
      select: { id: true },
    });
    const passes = await db.walletPass.findMany({
      where: { organizationId, serialNumber: { in: serials } },
      select: { id: true, status: true, platform: true },
    });
    for (const pass of passes) {
      if (pass.status === 'REVOKED' && runtime.mode !== 'TEST') {
        // The first revocation can race the upstream object creation. Deliver it again.
        await db.$executeRaw`INSERT INTO restaurant_wallet_pass_updates (id,"organizationId","passId",reason,"nextAttemptAt","updatedAt")
          VALUES (gen_random_uuid()::text,${organizationId},${pass.id},'REVOKE',now(),now())
          ON CONFLICT ("passId") WHERE status='PENDING' DO UPDATE SET reason='REVOKE',"nextAttemptAt"=now(),"updatedAt"=now()`;
      }
    }
    if (
      !enabled ||
      passes.length !== serials.length ||
      passes.some((pass) => pass.status !== 'ACTIVE')
    )
      return false;
    const apple = passes.find((pass) => pass.platform === 'APPLE');
    if (apple && appleHash) {
      const changed = await db.walletPass.updateMany({
        where: { id: apple.id, status: 'ACTIVE' },
        data: { appleAuthTokenHash: appleHash },
      });
      return changed.count === 1;
    }
    return true;
  });
  if (!ready) throw new Error('Wallet pass is no longer active.');
  return files;
}
