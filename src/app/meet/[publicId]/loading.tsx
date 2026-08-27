export default function MeetingLoading() {
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-surface-page p-4"
      aria-busy="true"
    >
      <p className="font-mono text-xs tracking-wider text-text-muted uppercase">Preparing lobby…</p>
    </main>
  );
}
