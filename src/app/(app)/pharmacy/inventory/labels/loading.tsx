import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function LoadingShelfLabels() {
  return <main className="min-w-0 space-y-6"><PageHeader eyebrow="Pharmacy / inventory" heading="Shelf and price labels" description="Print lot-specific prices for legacy packs and loose stock." /><SectionCard title="Loading labels"><p role="status" className="text-sm text-text-muted">Reading authorized branches, received lots and current pack prices…</p></SectionCard></main>;
}
