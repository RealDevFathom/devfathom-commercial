import { z } from 'zod';
import { after, NextResponse } from 'next/server';
import { requirePlatformSession } from '@/lib/platform/auth';
import { executePlatformCommand } from '@/lib/platform/commands';
import { formatValidationError } from '@/lib/validation-error';
import {
  ActivationPreflightError,
  assertPlatformMutationOrigin,
  PlatformSecurityError,
} from '@/lib/platform/security';

const envelope = z.object({
  action: z.string(),
  payload: z.unknown(),
});

export async function POST(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    const actor = await requirePlatformSession(request);
    const command = envelope.parse(await request.json());
    const data = await executePlatformCommand(actor, command.action, command.payload, request);
    if (['organization.create', 'crm.opportunity.convert'].includes(command.action.trim())) {
      const pharmacy = z
        .object({ id: z.string(), vertical: z.literal('PHARMACY') })
        .safeParse(data);
      if (pharmacy.success) {
        // Setup already committed the durable queue entry. Start filling this pharmacy
        // after responding, without waiting for the next scheduled recovery pass.
        after(async () => {
          const { processStarterImports } = await import('@/lib/pharmacy/migration/starter-worker');
          await processStarterImports(pharmacy.data.id);
        });
      }
    }
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const validation = formatValidationError(error);
      const fieldErrors = Object.fromEntries(
        error.issues.map((issue) => [
          issue.path.join('.') || '_root',
          issue.message || 'This field is invalid.',
        ])
      );
      return NextResponse.json(
        { error: validation?.message ?? 'Check the highlighted fields.', fieldErrors },
        { status: 400 }
      );
    }
    // WHA-1180 — a failed activation preflight also reports which gates are
    // unmet and where to satisfy each one. The message is unchanged, so a
    // client that only reads `error` sees exactly what it saw before.
    if (error instanceof ActivationPreflightError) {
      return NextResponse.json(
        { error: error.message, gates: error.gates },
        { status: error.status }
      );
    }
    if (error instanceof PlatformSecurityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Platform control command failed:', error);
    return NextResponse.json(
      { error: 'The platform command could not be completed.' },
      { status: 500 }
    );
  }
}
