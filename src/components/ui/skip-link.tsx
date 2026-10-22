export function SkipLink({ targetId }: { targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only fixed top-3 left-3 z-[100] rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
    >
      Skip to content
    </a>
  );
}
