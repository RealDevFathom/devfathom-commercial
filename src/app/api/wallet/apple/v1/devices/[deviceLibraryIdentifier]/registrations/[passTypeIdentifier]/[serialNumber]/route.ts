import { registerApplePass, unregisterApplePass } from '@/lib/restaurant/wallet/apple-web-service';

type Params = Promise<{
  deviceLibraryIdentifier: string;
  passTypeIdentifier: string;
  serialNumber: string;
}>;
export async function POST(request: Request, { params }: { params: Params }) {
  return registerApplePass(request, await params);
}
export async function DELETE(request: Request, { params }: { params: Params }) {
  return unregisterApplePass(request, await params);
}
