import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { lookupUniversityRecords } from '@/lib/university/lookup';
import { SectionCard } from '@/components/ui/section-card';
import {
  bindOfficeScope,
  canPerformOfficeAction,
  canAccessOffice,
  UniversityAccessError,
  withUniversityStaff,
} from '@/lib/university/access';
import { universityOffices } from '@/lib/university/offices';

import { OperationForm } from './operation-form';

function display(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
  if (typeof value === 'object')
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    );
  return String(value);
}

export default async function OfficePage({
  params,
  searchParams,
}: {
  params: Promise<{ office: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { office: officeKey } = await params;
  const { q } = await searchParams;
  const query = typeof q === 'string' ? q.trim().slice(0, 120) : '';
  const searchable = ['admissions', 'academics', 'finance'].includes(officeKey);
  const office = universityOffices.get(officeKey);
  if (!office) notFound();
  const { rows, actions } = await withUniversityStaff(async (ctx) => {
    if (!canAccessOffice(ctx, office)) throw new UniversityAccessError();
    await bindOfficeScope(ctx, office);
    return {
      rows:
        searchable && query.length >= 2
          ? await lookupUniversityRecords(ctx, officeKey, query)
          : await office.read(ctx),
      actions: office.actions.filter((action) => canPerformOfficeAction(ctx, office, action)),
    };
  }).catch((error) => {
    if (error instanceof UniversityAccessError) notFound();
    throw error;
  });
  const discriminator = officeKey === 'finance' ? 'category' : 'record';
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const title = typeof row[discriminator] === 'string' ? String(row[discriminator]) : '';
    const group = groups.get(title);
    if (group) group.push(row);
    else groups.set(title, [row]);
  }
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/university">University offices</Link>}
        heading={office.title}
        description={office.description}
        actions={
          officeKey === 'admissions' ? (
            <Link className="underline underline-offset-4" href="/university/admissions/documents">
              Review application documents
            </Link>
          ) : undefined
        }
      />
      <div className="grid gap-6">
        <SectionCard title="Records">
          {searchable && (
            <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm">
                Find a record by name or reference
                <Input name="q" minLength={2} maxLength={120} defaultValue={query} />
              </label>
              <Button type="submit" variant="outline">
                Search
              </Button>
              {query && (
                <Link href={`/university/${officeKey}`} className="underline">
                  Clear
                </Link>
              )}
            </form>
          )}
          {rows.length ? (
            <div className="grid min-w-0 gap-5">
              {[...groups].map(([title, records]) => {
                const columns = [...new Set(records.flatMap(Object.keys))].filter(
                  (column) => !title || column !== discriminator
                );
                return (
                  <div key={title} className="max-h-[28rem] overflow-auto">
                    <table className="w-full text-left text-sm">
                      {title && (
                        <caption className="mb-2 text-left font-semibold text-text-strong">
                          {title}
                        </caption>
                      )}
                      <thead>
                        <tr>
                          {columns.map((key) => (
                            <th
                              key={key}
                              scope="col"
                              className="sticky top-0 border-b bg-card px-2 py-2 font-medium"
                            >
                              {key.replaceAll('_', ' ')}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((row, index) => (
                          <tr key={index}>
                            {columns.map((key) => (
                              <td
                                key={key}
                                className="max-w-md break-words border-b px-2 py-2 align-top"
                              >
                                {display(row[key])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-text-muted">{query ? 'No matching records.' : 'No records yet.'}</p>
          )}
        </SectionCard>
        {actions.length > 0 && (
          <SectionCard title="Operations">
            <div className="grid gap-3">
              {actions.map(({ key, label, fields, confirmation }) => (
                <OperationForm
                  key={key}
                  officeKey={officeKey}
                  actionKey={key}
                  label={label}
                  fields={fields}
                  confirmation={confirmation}
                />
              ))}
            </div>
          </SectionCard>
        )}
      </div>
    </>
  );
}
