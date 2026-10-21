import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <SectionCard aria-busy="true" aria-label="Loading branch settings">
      <div className="h-24 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none" />
    </SectionCard>
  );
}
