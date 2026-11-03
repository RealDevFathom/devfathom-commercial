/** Names stay primary; keyboard and touch users can inspect the original identifier. */
export function ReportIdentity({
  name,
  id,
}: {
  name: string | null | undefined;
  id?: string | null;
}) {
  return (
    <div className="inline-block max-w-full break-words">
      <span>{name || 'Name not recorded'}</span>
      {id ? (
        <details className="mt-1 text-xs text-text-muted">
          <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">
            Reference
          </summary>
          <span className="break-all">{id}</span>
        </details>
      ) : null}
    </div>
  );
}
