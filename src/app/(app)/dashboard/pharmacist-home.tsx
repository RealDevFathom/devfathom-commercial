import Link from 'next/link';
import { ClipboardCheck, FileText } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import type { Action } from '@/lib/abac/policies';
import { isModuleGranted } from '@/lib/module-catalog';

const PHARMACIST_TOOLS = [
  {
    capability: 'pharmacy:dispense',
    href: '/pharmacy/pharmacist-queue',
    label: 'Pharmacist queue',
    description: 'Review prescriptions waiting for a pharmacist decision and record substitutions.',
    icon: ClipboardCheck,
  },
  {
    capability: 'pharmacy:prescriptions',
    href: '/pharmacy/prescriptions',
    label: 'Prescriptions',
    description: 'Capture prescriptions and open the records and files behind each one.',
    icon: FileText,
  },
] as const;

/** The only capabilities the dashboard landing decision reads. */
export const PHARMACIST_LANDING_CAPABILITIES = [
  'reports:operational',
  'pharmacy:dispense',
  'pharmacy:prescriptions',
] as const satisfies readonly Action[];

export type PharmacistTool = (typeof PHARMACIST_TOOLS)[number];

/**
 * DEV-95: the owner command centre is built only from `reports:operational`
 * reads. A pharmacist — a member granted `pharmacy:dispense`, which is
 * exact-grant-only and has no tenant-admin fallback — who cannot use the
 * command centre gets this home instead, so the dashboard never asks Pharmacy
 * Reports for a branch list the server will refuse. `pharmacy:prescriptions`
 * alone does not make a pharmacist: tenant administrators hold it by policy.
 * Returns null when the member belongs on the command centre.
 */
export function pharmacistLanding(
  capabilities: readonly string[],
  enabledModules: readonly string[] | null | undefined
): { tools: PharmacistTool[]; home: string | null } | null {
  if (!capabilities.includes('pharmacy:dispense')) return null;
  const modules = enabledModules ?? [];
  const reportHolder = capabilities.includes('reports:operational');
  // The command centre needs both the grant and the licensed module.
  if (reportHolder && isModuleGranted('pharmacy-reports', modules)) return null;
  const tools = isModuleGranted('pharmacy-dispensing', modules)
    ? PHARMACIST_TOOLS.filter((tool) => capabilities.includes(tool.capability))
    : [];
  // A report holder without licensed Reports goes to their own licensed tools;
  // with none of those either, the command centre's package notice is the
  // clearer page for them.
  if (reportHolder && !tools.length) return null;
  return { tools, home: tools[0]?.href ?? null };
}

/** The pharmacy home for a pharmacist: a direct way into their own queues. */
export function PharmacistHome({ tools }: { tools: readonly PharmacistTool[] }) {
  const [primary] = tools;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Pharmacy workspace"
        heading="Pharmacist home"
        description="Pick up prescriptions waiting for a pharmacist and keep dispensing moving."
        actions={
          primary ? (
            <Link href={primary.href} className={buttonVariants({ size: 'touch' })}>
              <primary.icon aria-hidden />
              Open {primary.label}
            </Link>
          ) : null
        }
      />
      {tools.length ? (
        <div className="grid min-w-0 gap-5 lg:grid-cols-2">
          {tools.map((tool) => (
            <SectionCard key={tool.href} eyebrow="Dispensing" title={tool.label} titleLevel={2}>
              <p className="max-w-2xl text-sm leading-6 text-text-body">{tool.description}</p>
              <Link
                href={tool.href}
                className={buttonVariants({ variant: 'outline', size: 'touch', className: 'mt-4' })}
              >
                Go to {tool.label}
              </Link>
            </SectionCard>
          ))}
        </div>
      ) : (
        <SectionCard eyebrow="Dispensing" title="Dispensing is not in your package" titleLevel={2}>
          <p role="status" className="max-w-2xl text-sm leading-6 text-text-body">
            The pharmacist queue and prescriptions are part of Pharmacy Dispensing, which your
            organization’s package does not include. An organization administrator can add it.
          </p>
        </SectionCard>
      )}
    </div>
  );
}
