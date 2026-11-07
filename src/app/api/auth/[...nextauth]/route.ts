import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { handleAuthRequest } from '@/lib/auth/session-cookie-refresh';

export function GET(request: NextRequest): Promise<Response> {
  return handleAuthRequest(request, handlers.GET, { secret: process.env.AUTH_SECRET });
}

export function POST(request: NextRequest): Promise<Response> {
  return handleAuthRequest(request, handlers.POST, { secret: process.env.AUTH_SECRET });
}
