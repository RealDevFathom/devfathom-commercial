import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  PrintJobSchema,
  RawPrintValidationError,
  PrintRoutingConfigSchema,
  type PrintDocumentType,
} from '@/lib/restaurant/printing/contract';
import {
  acknowledgePrintJob,
  claimNextPrintJob,
  PrintBridgeService,
} from '@/lib/restaurant/printing/service';
import { withDeviceAuth } from '@/lib/restaurant/terminal-auth';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';
import { requireRestaurantBranchScope } from '@/server/restaurant-branch-scope';

const ACTION_FOR_DOCUMENT: Record<PrintDocumentType, Action> = {
  KITCHEN_TICKET: 'orders:read',
  BAR_TICKET: 'orders:read',
  RECEIPT: 'money:read',
};

const bridgeAckBody = z
  .object({
    jobId: z.string().min(1),
    claimToken: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['PRINTED', 'OFFLINE']),
    error: z.string().trim().max(500).optional(),
  })
  .strict();

function isBridgeRequest(request: Request) {
  return request.headers.get('authorization')?.startsWith('Bearer rdk_') ?? false;
}

const bridgeClaim = withDeviceAuth(async (ctx, request) => {
  const rawWait = new URL(request.url).searchParams.get('wait');
  const waitSeconds = Math.min(20, Math.max(0, Number.parseInt(rawWait ?? '15', 10) || 0));
  const deadline = Date.now() + waitSeconds * 1_000;
  do {
    const job = await claimNextPrintJob(ctx.db, ctx.device.branchId, ctx.device.id);
    if (job) return NextResponse.json({ job });
    if (Date.now() >= deadline || request.signal.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (true);
  return new NextResponse(null, { status: 204 });
}, { allowedDeviceKinds: ['POS', 'KDS', 'PRINT_BRIDGE'] });

const bridgeAck = withDeviceAuth(async (ctx, request) => {
  const parsed = bridgeAckBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid print acknowledgement.' }, { status: 400 });
  }
  const result = await acknowledgePrintJob(ctx.db, {
    branchId: ctx.device.branchId,
    deviceId: ctx.device.id,
    jobId: parsed.data.jobId,
    claimToken: parsed.data.claimToken,
    status: parsed.data.status,
  });
  if (!result.acknowledged) {
    return NextResponse.json({ error: 'Print job not found.' }, { status: 404 });
  }
  if (parsed.data.status === 'OFFLINE' && parsed.data.error) {
    console.warn(`Print bridge reported job ${parsed.data.jobId} offline: ${parsed.data.error}`);
  }
  return NextResponse.json(result);
}, { allowedDeviceKinds: ['POS', 'KDS', 'PRINT_BRIDGE'] });

function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

async function context(request: Request) {
  const ctx = await createTRPCContext({ req: request });
  if (!ctx.session?.user) return null;
  return ctx as TRPCContext & { session: NonNullable<TRPCContext['session']> };
}

async function permitted(ctx: NonNullable<Awaited<ReturnType<typeof context>>>, action: Action) {
  return can(subjectFromSession(ctx.session.user), action, undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta.ip,
  });
}

async function branchExists(
  ctx: NonNullable<Awaited<ReturnType<typeof context>>>,
  branchId: string
) {
  await requireRestaurantBranchScope(ctx, branchId);
  return ctx.db.restaurantBranch.findUnique({ where: { id: branchId }, select: { id: true } });
}

async function branchAccessError(
  ctx: NonNullable<Awaited<ReturnType<typeof context>>>,
  branchId: string
) {
  try {
    if (!(await branchExists(ctx, branchId))) {
      return NextResponse.json({ error: 'Branch not found.' }, { status: 404 });
    }
    return null;
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }
    throw error;
  }
}

/**
 * Web sessions manage routes and enqueue manual jobs. A branch-bound registered
 * device token long-polls and acknowledges the durable bridge queue.
 */
export async function GET(request: Request) {
  if (isBridgeRequest(request)) return bridgeClaim(request);
  const ctx = await context(request);
  if (!ctx) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!(await permitted(ctx, 'restaurant:configure'))) {
    return NextResponse.json(
      { error: 'You do not have permission to configure printing.' },
      { status: 403 }
    );
  }
  const branches = await ctx.db.restaurantBranch.findMany({
    where: { active: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      kitchenStations: { where: { active: true }, select: { id: true, name: true } },
    },
  });
  const configs = await ctx.db.restaurantPrintRoute.findMany({
    where: { branchId: { in: branches.map((branch) => branch.id) } },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({
    mode: 'DEVICE_BRIDGE',
    branches: branches.map((branch) => ({
      ...branch,
      config: {
        branchId: branch.id,
        routes: configs
          .filter((route) => route.branchId === branch.id)
          .map(({ documentType, stationId, printerId, enabled }) => ({
            documentType,
            stationId,
            printerId,
            enabled,
          })),
      },
    })),
  });
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  const ctx = await context(request);
  if (!ctx) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!(await permitted(ctx, 'restaurant:configure'))) {
    return NextResponse.json(
      { error: 'You do not have permission to configure printing.' },
      { status: 403 }
    );
  }
  const parsed = PrintRoutingConfigSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Invalid print routing configuration.' }, { status: 400 });
  const branchError = await branchAccessError(ctx, parsed.data.branchId);
  if (branchError) return branchError;
  const stationIds = new Set(
    (
      await ctx.db.restaurantKitchenStation.findMany({
        where: { branchId: parsed.data.branchId, active: true },
        select: { id: true },
      })
    ).map((station) => station.id)
  );
  if (parsed.data.routes.some((route) => route.stationId && !stationIds.has(route.stationId))) {
    return NextResponse.json(
      { error: 'A print route references a station outside this branch.' },
      { status: 400 }
    );
  }
  const organizationId = ctx.organization?.id ?? ctx.session.user.organizationId;
  await ctx.db.$transaction(async (db) => {
    await db.restaurantPrintRoute.deleteMany({ where: { branchId: parsed.data.branchId } });
    if (parsed.data.routes.length) {
      await db.restaurantPrintRoute.createMany({
        data: parsed.data.routes.map((route) => ({
          organizationId,
          branchId: parsed.data.branchId,
          ...route,
        })),
      });
    }
  });
  return NextResponse.json({ mode: 'DEVICE_BRIDGE', config: parsed.data });
}

export async function POST(request: Request) {
  if (isBridgeRequest(request)) return bridgeAck(request);
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  const ctx = await context(request);
  if (!ctx) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  const parsed = PrintJobSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid print job.' }, { status: 400 });
  if (!(await permitted(ctx, ACTION_FOR_DOCUMENT[parsed.data.document.type]))) {
    return NextResponse.json(
      { error: 'You do not have permission to print this document.' },
      { status: 403 }
    );
  }
  const branchError = await branchAccessError(ctx, parsed.data.branchId);
  if (branchError) return branchError;
  const organizationId = ctx.organization?.id ?? ctx.session.user.organizationId;
  let result;
  try {
    result = await ctx.db.$transaction(async (db) => {
      const routes = await db.restaurantPrintRoute.findMany({
        where: { branchId: parsed.data.branchId },
        select: { documentType: true, stationId: true, printerId: true, enabled: true },
      });
      return new PrintBridgeService(db).enqueue(
        organizationId,
        { branchId: parsed.data.branchId, routes },
        parsed.data
      );
    });
  } catch (error) {
    if (!(error instanceof RawPrintValidationError)) throw error;
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        fallback: error.fallback,
        retryable: false,
      },
      { status: 422 }
    );
  }
  return NextResponse.json(
    { mode: 'DEVICE_BRIDGE', result },
    { status: result.status === 'QUEUED' ? 202 : result.status === 'PRINTED' ? 200 : 409 }
  );
}
