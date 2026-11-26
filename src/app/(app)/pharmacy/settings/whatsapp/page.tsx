import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { ConnectionPanel } from './panel';
import { updateConnection } from './actions';
export const metadata = { title: 'Connect WhatsApp' };
export default async function Page() {
  const initial = await updateConnection({ action: 'refresh' });
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy settings"
        heading="Connect WhatsApp"
        description="Connect the pharmacy number and manage its sending limits."
      />
      {initial.access ? (
        <ConnectionPanel initial={initial} />
      ) : (
        <SectionCard title="Owner access required" titleLevel={2}>
          <p>Ask the pharmacy owner to manage the WhatsApp connection.</p>
        </SectionCard>
      )}
    </div>
  );
}
