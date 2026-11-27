import { OwnPinSettings } from '@/components/pharmacy/own-pin-settings';
import { MyTerminalCredentials } from '@/components/restaurant/my-terminal-credentials';
import { PageHeader } from '@/components/ui/page-header';
import { hasModule } from '@/lib/entitlements';
import { createTRPCContext } from '@/server/trpc';

export const metadata = { title: 'Your PIN' };

export default async function AccountPinPage() {
  const ctx = await createTRPCContext();
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Settings"
        heading="Your PIN"
        description="Manage your approval PIN and confirm changes with your account password."
      />
      <OwnPinSettings surface="accountPin" />
      {hasModule(ctx.entitlements, 'restaurant-core') && <MyTerminalCredentials />}
    </div>
  );
}
