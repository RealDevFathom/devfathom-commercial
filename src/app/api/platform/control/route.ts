import { z } from 'zod';
import { NextResponse } from 'next/server';
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
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const validation = formatValidationError(error);
      const fieldErrors = Object.fromEntries(
        Object.entries(validation?.fields ?? {}).flatMap(([field, messages]) =>
          messages?.[0] ? [[field, messages[0]]] : []
        )
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
