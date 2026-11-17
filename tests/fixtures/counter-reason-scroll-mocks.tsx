// Synthetic transport/session only. The browser fixture renders the real Counter UI.
import type { ComponentProps } from 'react';
import type { CounterCart } from '@/lib/pharmacy/counter';

const bill: CounterCart = {
  saleId: 'synthetic-sale',
  status: 'OPEN',
  receiptNumber: null,
  lines: Array.from({ length: 18 }, (_, index) => ({
    saleLineId: `synthetic-line-${index}`,
    medicineId: `synthetic-medicine-${index}`,
    medicineName: `Synthetic medicine ${index + 1}`,
    strength: null,
    presentation: 'Pack',
    saleUnit: 'PACK',
    quantity: 1,
    canonicalUnits: 1,
    unitPriceMinor: 100,
    proRataCeilingMinor: 100,
    discountMinor: 0,
    lineTotalMinor: 100,
    rx: false,
    controlled: false,
    restricted: false,
    highAlert: false,
    lasa: false,
    coldChain: false,
    emergencySupply: false,
    allocations: [],
  })),
  totals: { grossMinor: 1800, discountMinor: 0, netMinor: 1800, tenderedMinor: 0 },
};
const data: Record<string, unknown> = {
  counterBranches: {
    branches: [{ id: 'synthetic-branch', name: 'Synthetic branch', code: 'TEST' }],
  },
  settlementAccess: { authorized: true, userId: 'synthetic-user', organizationId: 'synthetic-org' },
  counterCart: bill,
  drawerStatus: { openDrawer: { id: 'synthetic-drawer' } },
  upsellSuggestions: [
    {
      medicineId: 'synthetic-spacer',
      presentationId: 'synthetic-presentation',
      displayName: 'Synthetic spacer',
      presentation: 'Each',
      availableCanonicalUnits: 3,
      packMrpMinor: 100,
      ruleId: 'synthetic-rule',
      reason: 'Often bought together',
    },
  ],
};
type FixtureQuery = {
  data: unknown;
  isSuccess: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isStale: boolean;
  isPlaceholderData: boolean;
  refetch: () => Promise<FixtureQuery>;
};
const queries = new Map<string, FixtureQuery>();
const queryFor = (name: string): FixtureQuery => {
  if (!queries.has(name))
    queries.set(name, {
      data: data[name],
      isSuccess: true,
      isLoading: false,
      isFetching: false,
      isError: false,
      isStale: false,
      isPlaceholderData: false,
      refetch: async () => queryFor(name),
    });
  return queries.get(name)!;
};
const calls: string[] = [];
const mutation = (name: string) => ({
  isPending: false,
  isPaused: false,
  error: null,
  mutate: () => {
    throw new Error(`Unexpected synthetic mutation: ${name}`);
  },
  mutateAsync: () => {
    calls.push(name);
    if (name !== 'transition') throw new Error(`Unexpected synthetic mutation: ${name}`);
    return new Promise((_resolve, reject) => {
      window.addEventListener('fixture:release', () => reject(new Error('Synthetic refusal')), {
        once: true,
      });
    });
  },
});
const router = new Proxy(
  {},
  {
    get: (_target, name: string) => ({
      useQuery: () => queryFor(name),
      useMutation: () => mutation(name),
    }),
  }
);
const noOp = async () => undefined;
const utils: object = new Proxy(() => undefined, {
  get: (_target, name) => (name === 'then' ? undefined : utils),
  apply: () => undefined,
});
export const trpc = {
  useUtils: () => utils,
  pharmacySales: router,
  pharmacyPrescriptions: router,
  pharmacySafety: router,
  pharmacyAccess: router,
};
export const useSession = () => ({
  status: 'authenticated',
  data: {
    user: {
      id: 'synthetic-user',
      organizationId: 'synthetic-org',
      status: 'ACTIVE',
      sessionRevoked: false,
      role: 'EMPLOYEE',
      email: 'synthetic@example.invalid',
    },
  },
});
export const useEntitlements = () => ({
  organizationId: 'synthetic-org',
  enabledModules: ['pharmacy-counter', 'pharmacy-safety'],
});
export const signIn = noOp;
export const signOutEverything = noOp;
export const useRouter = () => ({ push: noOp, replace: noOp, refresh: noOp });
export const usePathname = () => '/pharmacy/counter';
export default function FixtureLink({
  prefetch,
  ...props
}: ComponentProps<'a'> & { prefetch?: boolean }) {
  void prefetch;
  return <a {...props} />;
}
window.addEventListener('fixture:check-mutations', () => {
  document.body.dataset.mutations = JSON.stringify(calls);
});
