import { sendUpdatedApplePass } from '@/lib/restaurant/wallet/apple-web-service';

type Params = Promise<{ passTypeIdentifier: string; serialNumber: string }>;
export async function GET(request: Request, { params }: { params: Params }) {
  return sendUpdatedApplePass(request, await params);
}
