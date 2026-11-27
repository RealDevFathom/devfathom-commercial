'use client';

import { trpc } from '@/lib/trpc';
import { SectionCard } from '@/components/ui/section-card';
import { WalletEditor } from './wallet-editor';

export default function WalletSettingsPage() {
  const settings = trpc.walletCards.settings.useQuery();
  const save = trpc.walletCards.save.useMutation();
  const poster = trpc.walletCards.poster.useMutation();
  if (!settings.data)
    return (
      <SectionCard title="Wallet loyalty card">
        <p role="status">
          {settings.isLoading
            ? 'Loading card design…'
            : settings.error?.data?.code === 'FORBIDDEN'
              ? 'Wallet settings require an authorized business admin.'
              : 'The card design could not be loaded.'}
        </p>
      </SectionCard>
    );
  return (
    <WalletEditor
      {...settings.data}
      onSave={(data) => save.mutateAsync(data)}
      onPoster={(branchId) => poster.mutateAsync({ branchId })}
    />
  );
}
