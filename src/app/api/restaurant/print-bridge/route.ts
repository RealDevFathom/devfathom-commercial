import { NextResponse } from 'next/server';

import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  PrintJobSchema,
  PrintRoutingConfigSchema,
  type PrintDocumentType,
} from '@/lib/restaurant/printing/contract';
import { simulatedPrintRuntime } from '@/lib/restaurant/printing/runtime';
import { PrintBridgeService } from '@/lib/restaurant/printing/service';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';

const ACTION_FOR_DOCUMENT: Record<PrintDocumentType, Action> = {
  KITCHEN_TICKET: 'orders:read',
  BAR_TICKET: 'orders:read',
  RECEIPT: 'money:read',
};

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
  return ctx.db.restaurantBranch.findUnique({ where: { id: branchId }, select: { id: true } });
}

/**
 * Simulation-only local print bridge boundary. GET/PUT manage branch routing;
 * POST renders and submits one idempotent job. No vendor SDK, daemon, or hardware I/O ships here.
 */
export async function GET(request: Request) {
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
  const runtime = simulatedPrintRuntime();
  const configs = await ctx.db.restaurantPrintRoute.findMany({
    where: { branchId: { in: branches.map((branch) => branch.id) } },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({
    mode: runtime.adapter.kind,
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
  if (!(await branchExists(ctx, parsed.data.branchId))) {
    return NextResponse.json({ error: 'Branch not found.' }, { status: 404 });
  }
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
  return NextResponse.json({ mode: 'SIMULATION_ONLY', config: parsed.data });
}

export async function POST(request: Request) {
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
  if (!(await branchExists(ctx, parsed.data.branchId))) {
    return NextResponse.json({ error: 'Branch not found.' }, { status: 404 });
  }
  const organizationId = ctx.organization?.id ?? ctx.session.user.organizationId;
  const runtime = simulatedPrintRuntime();
  const result = await ctx.db.$transaction(async (db) => {
    const routes = await db.restaurantPrintRoute.findMany({
      where: { branchId: parsed.data.branchId },
      select: { documentType: true, stationId: true, printerId: true, enabled: true },
    });
    return new PrintBridgeService(runtime.adapter, db).submit(
      organizationId,
      { branchId: parsed.data.branchId, routes },
      parsed.data
    );
  });
  return NextResponse.json(
    { mode: runtime.adapter.kind, result },
    { status: result.status === 'PRINTED' ? 200 : result.status === 'OFFLINE' ? 503 : 409 }
  );
}
