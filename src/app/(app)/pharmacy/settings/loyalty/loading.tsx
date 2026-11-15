import { SectionCard } from '@/components/ui/section-card';
export default function Loading() {
  return (
    <SectionCard title="Loyalty earning" titleLevel={2}>
      <p role="status">Loading earning settings and balance reconciliation…</p>
    </SectionCard>
  );
}
