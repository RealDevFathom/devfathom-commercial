import { portalManifest } from '@/lib/pharmacy/customer-portal-manifest';

export function GET() {
  return Response.json(portalManifest(), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
