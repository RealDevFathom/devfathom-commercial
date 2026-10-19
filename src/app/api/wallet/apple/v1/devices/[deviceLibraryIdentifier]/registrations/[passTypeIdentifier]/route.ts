import { listUpdatedApplePasses } from '@/lib/restaurant/wallet/apple-web-service';

type Params = Promise<{ deviceLibraryIdentifier: string; passTypeIdentifier: string }>;
export async function GET(request: Request, { params }: { params: Params }) {
  return listUpdatedApplePasses(request, await params);
}
