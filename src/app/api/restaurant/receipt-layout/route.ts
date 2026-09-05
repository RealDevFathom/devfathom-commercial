import { TRPCError } from '@trpc/server';
import { NextResponse } from 'next/server';
import { can, subjectFromSession } from '@/lib/abac';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { hasModule } from '@/lib/entitlements';
import { SaveReceiptLayoutSchema } from '@/lib/receipts/configuration';
import {
  listRestaurantReceiptLayouts,
  saveRestaurantReceiptLayout,
} from '@/lib/receipts/restaurant-settings';
import { createTRPCContext } from '@/server/trpc';

async function authorized(request: Request) {
  const ctx = await createTRPCContext({ req: request });
  const user = ctx.session?.user;
  const verdict = evaluateSessionUser(user);
  if (!user || !verdict.ok)
    throw new TRPCError({
      code: !verdict.ok && verdict.kind !== 'session-ended' ? 'FORBIDDEN' : 'UNAUTHORIZED',
      message: !verdict.ok ? verdict.message : 'Authentication required.',
    });
  const organizationId = ctx.organization?.id;
  if (
    !organizationId ||
    user.organizationId !== organizationId ||
    !hasModule(ctx.entitlements, 'restaurant-core') ||
    !(await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Receipt settings are unavailable for this account.',
    });
  return { db: ctx.db, organizationId };
}

function errorResponse(error: unknown) {
  const codes: Record<string, number> = {
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
  };
  const status = error instanceof TRPCError ? (codes[error.code] ?? 500) : 500;
  return NextResponse.json(
    {
      error:
        status === 500
          ? 'Receipt settings could not be loaded or saved. Try again.'
          : (error as TRPCError).message,
    },
    { status }
  );
}

export async function GET(request: Request) {
  try {
    const { db, organizationId } = await authorized(request);
    return NextResponse.json(
      { branches: await listRestaurantReceiptLayouts(db, organizationId) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  // Settings are a browser-session surface. Fail closed when Origin is absent.
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }
  try {
    const { db, organizationId } = await authorized(request);
    const raw = await request.text();
    if (raw.length > 8192)
      return NextResponse.json({ error: 'Receipt settings are too large.' }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid receipt settings.' }, { status: 400 });
    }
    const parsed = SaveReceiptLayoutSchema.safeParse(json);
    if (!parsed.success)
      return NextResponse.json(
        { error: 'Check the receipt fields. Use plain text within the displayed limits.' },
        { status: 400 }
      );
    return NextResponse.json(await saveRestaurantReceiptLayout(db, organizationId, parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
