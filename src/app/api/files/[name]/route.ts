import { get } from '@vercel/blob';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

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

  // IMP-RT-05: per-channel membership enforcement. If this file is a chat
  // attachment, only members of its channel may fetch it — a stale URL no longer
  // leaks a private-channel/DM file to any signed-in user. Non-chat uploads
  // (project files, avatars, client logos) keep the session-only gate; they have
  // their own visibility model and aren't in this ticket's scope.
  const attachment = await db.messageAttachment.findFirst({
    where: { url: '/api/files/' + name },
    select: { message: { select: { channelId: true } } },
  });
  if (attachment) {
    const member = await db.channelMember.findUnique({
      where: {
        channelId_userId: {
          channelId: attachment.message.channelId,
          userId: session.user.id,
        },
      },
      select: { id: true },
    });
    if (!member) {
      // 404 (not 403) so non-members can't even confirm the file exists.
      return new Response('Not found', { status: 404 });
    }
  }

  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const result = await get(name, { access: 'private' });
      if (result?.statusCode !== 200) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(result.stream, {
        headers: {
          'Content-Type': result.blob.contentType ?? contentType,
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }

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
