import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <SectionCard title="Loading account activity" titleLevel={2}>
      <p role="status">Authorizing and reading posted aggregates…</p>
    </SectionCard>
  );
}
