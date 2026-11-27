import { NextResponse } from 'next/server';
import { withApiAuth } from '@/lib/api-auth';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import { runUniversityCommand, universityCommandSchema } from '@/lib/university/inbound';

export const POST = withApiAuth('university:integrations:write', async (ctx, request) => {
  const body = await readBoundedJson(request, 16_384).catch(() => null);
  if (!body || body.tooLarge)
    return NextResponse.json(
      { error: 'Invalid university command body.' },
      { status: body?.tooLarge ? 413 : 400 }
    );
  const command = universityCommandSchema.safeParse(body.value);
  if (!command.success)
    return NextResponse.json(
      { error: 'Unknown command version, type or payload.' },
      { status: 400 }
    );
  return NextResponse.json(await runUniversityCommand(ctx, command.data), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
