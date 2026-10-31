import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readJson } from '@/lib/api-json';
import {
  mintPosComposerProof,
  verifyPosComposerProofForRenewal,
} from '@/lib/restaurant/pos-composer-proof';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';

const bodySchema = z.object({ originalProof: z.string().min(1) }).strict();

/** Renew a queued draft's proof only when its signed composer is still the active operator. */
export const POST = withTerminalAuth(async (ctx, request) => {
  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.data);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  const staffProfileId = ctx.session.activeStaffProfileId;
  if (
    ctx.state !== 'UNLOCKED' ||
    !staffProfileId ||
    !verifyPosComposerProofForRenewal(parsed.data.originalProof, {
      organizationId: ctx.organizationId,
      branchId: ctx.device.branchId,
      deviceId: ctx.device.id,
      staffProfileId,
    })
  ) {
    return NextResponse.json(
      { error: 'Composer proof does not belong to the active operator.' },
      { status: 403 }
    );
  }

  return NextResponse.json({
    composerProof: mintPosComposerProof({
      organizationId: ctx.organizationId,
      branchId: ctx.device.branchId,
      deviceId: ctx.device.id,
      sessionId: ctx.session.id,
      staffProfileId,
    }),
  });
});
