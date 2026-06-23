// RT-05 — authenticated attachment delivery (DEV local-FS storage).
//
// Previously uploads were written to public/uploads and served statically with
// ZERO authorization — anyone who obtained the URL (a since-removed member, a
// referer/log leak, link sharing) could fetch private-DM voice notes/files
// forever. This route requires a valid session before streaming the bytes, so a
// stale URL no longer leaks to anonymous or signed-out users. (Per-channel
// membership enforcement / signed URLs are the linked production enhancement.)

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auth } from '@/lib/auth';

// Kept OUTSIDE public/ so the platform never serves these statically.
const UPLOAD_DIR = join(process.cwd(), 'private-uploads');

// Mirrors the upload allowlist — non-executable types served inline same-origin.
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
};

export async function GET(_request: Request, ctx: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { name } = await ctx.params;
  // Defense-in-depth against path traversal — only a bare filename is valid.
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return new Response('Bad request', { status: 400 });
  }

  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  try {
    const data = await readFile(join(UPLOAD_DIR, name));
    return new Response(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        // Private so shared caches never hold an authenticated user's file.
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
