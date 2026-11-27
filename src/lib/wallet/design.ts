import 'server-only';
import sharp from 'sharp';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { mintWalletAlias } from './alias';

const colour = z.string().regex(/^#[a-f0-9]{6}$/i);
export const cardDesignInput = z
  .object({
    programDisplayName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[\p{L}\p{M}\p{N} &’'.,()\-]+$/u),
    backgroundColor: colour,
    foregroundColor: colour,
    enabled: z.boolean(),
    // Omitted keeps the saved logo. Null removes it. Only a local image upload is accepted.
    logo: z.string().base64().max(350_000).nullable().optional(),
  })
  .strict();
export type CardDesignInput = z.infer<typeof cardDesignInput>;

export async function saveCardDesign(db: ScopedDb, organizationId: string, input: CardDesignInput) {
  const { logo, ...design } = cardDesignInput.parse(input);
  let logoPng: Uint8Array<ArrayBuffer> | null | undefined;
  if (logo === null) logoPng = null;
  else if (logo) {
    const bytes = Buffer.from(logo, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      throw new Error('Choose a PNG image.');
    logoPng = Uint8Array.from(
      await sharp(bytes, { limitInputPixels: 4_000_000 })
        .resize(240, 240, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
    );
  }
  const data = { ...design, ...(logoPng !== undefined ? { logoPng, logoFileId: null } : {}) };
  return db.walletTenantConfig.upsert({
    where: { organizationId },
    create: {
      organizationId,
      ...data,
      googleClassSuffix: mintWalletAlias().replace('wla_', 'wgc_'),
    },
    update: data,
    select: { id: true },
  });
}
