import { z } from 'zod';

import { protectedProcedure, router } from '../trpc';

export const RESTAURANT_DASHBOARD_WIDGET_KEYS = [
  'performance',
  'trend',
  'exceptions',
  'itemMix',
  'labour',
] as const;

const widgetPreference = z
  .object({
    key: z.enum(RESTAURANT_DASHBOARD_WIDGET_KEYS),
    visible: z.boolean(),
    span: z.enum(['compact', 'wide']),
  })
  .strict();

export const restaurantDashboardPreferenceSchema = z
  .object({
    version: z.literal(1),
    defaultBranchId: z.string().min(1).max(200).nullable(),
    rangeDays: z.union([z.literal(7), z.literal(30)]),
    widgets: z.array(widgetPreference).length(RESTAURANT_DASHBOARD_WIDGET_KEYS.length),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.widgets.map((widget) => widget.key);
    if (
      new Set(keys).size !== RESTAURANT_DASHBOARD_WIDGET_KEYS.length ||
      RESTAURANT_DASHBOARD_WIDGET_KEYS.some((key) => !keys.includes(key))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['widgets'],
        message: 'Each dashboard widget must appear exactly once.',
      });
    }
  });

export type RestaurantDashboardPreference = z.infer<typeof restaurantDashboardPreferenceSchema>;

export const DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE: RestaurantDashboardPreference = {
  version: 1,
  defaultBranchId: null,
  rangeDays: 7,
  widgets: [
    { key: 'performance', visible: true, span: 'wide' },
    { key: 'trend', visible: true, span: 'wide' },
    { key: 'exceptions', visible: true, span: 'compact' },
    { key: 'itemMix', visible: true, span: 'compact' },
    { key: 'labour', visible: true, span: 'wide' },
  ],
};

function preferenceObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function parseRestaurantDashboardPreference(raw: unknown): RestaurantDashboardPreference {
  const parsed = restaurantDashboardPreferenceSchema.safeParse(
    preferenceObject(raw).restaurantDashboard
  );
  return parsed.success ? parsed.data : DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE;
}

export const restaurantDashboardRouter = router({
  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { preferences: true },
    });
    return parseRestaurantDashboardPreference(user?.preferences);
  }),

  updatePreferences: protectedProcedure
    .input(restaurantDashboardPreferenceSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { preferences: true },
      });
      const base = preferenceObject(existing?.preferences);

      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { preferences: { ...base, restaurantDashboard: input } },
      });
      return input;
    }),
});
