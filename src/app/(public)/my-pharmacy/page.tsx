import { PortalHome } from './portal-home';

export const dynamic = 'force-dynamic';

export default function MyPharmacyPage() {
  return (
    <main className="min-h-dvh bg-surface-page px-4 py-8 text-text-body sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <PortalHome />
      </div>
    </main>
  );
}
