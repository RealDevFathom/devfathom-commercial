import { tool } from 'ai';
import { z } from 'zod';

import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';
import { PHARMACY_METRIC_CONTRACT, readPharmacyOwnerCommandCentre } from '@/lib/pharmacy/reports';

const REFUSAL = 'I cannot answer that from the pharmacy reports you are authorized to see.';
const UNSUPPORTED =
  'I cannot answer that from authorized reports because no supporting metric exists.';
const UNAVAILABLE = 'Pharmacy report data is currently unavailable. No stale figures were used.';

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function drillThrough(path: string, filters: { branchIds: string[]; from: string; to: string }) {
  const url = new URL(path, 'https://reports.invalid');
  url.searchParams.set('from', filters.from);
  url.searchParams.set('to', filters.to);
  if (filters.branchIds.length === 1) url.searchParams.set('branchId', filters.branchIds[0]);
  return `${url.pathname}${url.search}`;
}

/** Read-only RPT-02 extension for the existing Ask Fathom tool assembly. */
export function buildPharmacyReportTools(h: AssistantHelpers): ToolSet {
  if (!h.ctx.enabledModules?.includes('pharmacy-reports')) return {};

  return {
    askPharmacyReports: tool({
      description:
        'Answer pharmacy reporting questions only from authorized RPT-02 metric contracts. Returns cited aggregate claims, or an explicit refusal/cannot-answer/unavailable result. Never use for patient or clinical facts.',
      inputSchema: z.object({
        metricKeys: z
          .array(z.string().trim().min(1).max(128))
          .min(1)
          .max(PHARMACY_METRIC_CONTRACT.length)
          .describe(
            `Exact pharmacy metric contract keys needed to answer the question: ${PHARMACY_METRIC_CONTRACT.map(({ key }) => key).join(', ')}`
          ),
        branch: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .nullish()
          .describe('Exact branch id or name; omit to use every authorized active branch'),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullish(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullish(),
      }),
      execute: async ({ metricKeys, branch, from, to }) => {
        if (!(await h.can('reports:operational'))) return { kind: 'refusal', message: REFUSAL };

        const contracts = metricKeys.map((key) =>
          PHARMACY_METRIC_CONTRACT.find((metric) => metric.key === key)
        );
        if (contracts.some((metric) => !metric?.source || !metric.drillThrough)) {
          return { kind: 'cannot_answer', message: UNSUPPORTED };
        }
        if (
          contracts.some((metric) => metric?.permission === 'reports:financial') &&
          !(await h.can('reports:financial'))
        ) {
          return { kind: 'refusal', message: REFUSAL };
        }

        try {
          const branches = await h.db.pharmacyBranch.findMany({
            where: { organizationId: h.ctx.organizationId, active: true },
            orderBy: { name: 'asc' },
            select: { id: true, name: true },
          });
          const selected = branch
            ? branches.filter(
                (candidate) =>
                  candidate.id === branch || candidate.name.toLowerCase() === branch.toLowerCase()
              )
            : branches;
          if (!selected.length || (branch && selected.length !== 1)) {
            return { kind: 'refusal', message: REFUSAL };
          }

          const filters = {
            branchIds: selected.map(({ id }) => id),
            from: from ?? utcDate(),
            to: to ?? from ?? utcDate(),
          };
          const report = await readPharmacyOwnerCommandCentre(h.db, filters);
          const values = report.metrics as Record<string, number | null>;
          return {
            kind: 'answer',
            branches: selected.map(({ id, name }) => ({ id, name })),
            period: { from: filters.from, to: filters.to },
            claims: contracts.map((metric) => ({
              metricKey: metric!.key,
              label: metric!.label,
              value: values[metric!.key],
              definition: metric!.definition,
              source: metric!.source,
              scope: {
                contract: metric!.scope,
                branchIds: filters.branchIds,
                from: filters.from,
                to: filters.to,
              },
              freshness: report.freshness,
              drillThrough: drillThrough(metric!.drillThrough!, filters),
            })),
            instruction:
              'Use only these claims. Every numeric statement must retain its metric definition, scope, freshness, and drill-through link.',
          };
        } catch {
          return { kind: 'unavailable', message: UNAVAILABLE };
        }
      },
    }),
  };
}
