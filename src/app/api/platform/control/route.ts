import { z } from 'zod';
import { NextResponse } from 'next/server';
import { requirePlatformSession } from '@/lib/platform/auth';
import { executePlatformCommand } from '@/lib/platform/commands';
import { assertPlatformMutationOrigin, PlatformSecurityError } from '@/lib/platform/security';

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
      return NextResponse.json(
        { error: 'The command payload is invalid.', details: error.issues },
        { status: 400 }
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
