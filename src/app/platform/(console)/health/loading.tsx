import { SectionCard } from '@/components/ui/section-card';
export default function HealthLoading() {
  return (
    <SectionCard title="Loading platform health" titleLevel={2}>
      <p role="status">Reading queue and integration observations…</p>
    </SectionCard>
  );
}
