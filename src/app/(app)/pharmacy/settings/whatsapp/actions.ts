'use server';
import { createTRPCContext } from '@/server/trpc';
import { manageWaha, type WahaCommand } from '@/lib/pharmacy/whatsapp/waha-admin';
export async function updateConnection(command: WahaCommand) {
  return manageWaha(await createTRPCContext(), command);
}
