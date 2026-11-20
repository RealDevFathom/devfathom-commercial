import { useState } from 'react';
import { gapPharmacyHotelQueryData } from './dev-1001-gap-pharmacy-hotel-fixtures';
import { gapRestaurantQueryData } from './dev-1001-gap-restaurant-fixtures';
import { operationsFlowQueryData } from './dev-1001-operations-flow-fixtures';
import { platformQueryData } from './dev-1001-gap-platform-fixtures';
import { additionalQueryData, additionalMutationData } from './dev-1001-additional-fixtures';
import { pharmacyQueryData, pharmacyMutationData } from './dev-1001-pharmacy-fixtures';
import { generalQueryData } from './dev-1001-general-fixtures';
import { managementQueryData } from './dev-1001-management-fixtures';
import { IMPORT_FIELDS } from '../../src/lib/pharmacy/migration/owner-import-input';

const mode = () => new URLSearchParams(location.search).get('state') ?? 'default';
const branches = [{ id: 'branch-a', name: 'Garden branch' }, { id: 'branch-b', name: 'Riverside branch' }];
const locations = branches.map((branch, index) => ({ id: `location-${index}`, branchId: branch.id, name: index ? 'Back room' : 'Main shelves' }));
function useMutation(path: string) {
  const [isPending, setPending] = useState(false);
  return { isPending, mutate: () => {}, reset: () => {}, mutateAsync: async () => {
    setPending(true);
    try {
      if (path.endsWith('.upload')) return { headers: IMPORT_FIELDS.map(([, label]) => label), mapping: Object.fromEntries(IMPORT_FIELDS.map(([field], index) => [field, index])), rowCount: 1, sample: [IMPORT_FIELDS.map(() => 'Sample value')] };
      if (path.endsWith('.preview')) return { canCommit: false, previewHash: 'isolated-preview', lines: [], totalUnits: 0, totalValueMinor: '0', blockers: ['Fixture: unmatched pack. No inventory has changed.'] };
      if (path.slice(1) in additionalMutationData) return additionalMutationData[path.slice(1)];
      if (path.slice(1) in pharmacyMutationData) return pharmacyMutationData[path.slice(1)];
      throw new Error('Fixture mutations cannot reach a server.');
    } finally { setPending(false); }
  }};
}
const nodes = new Map<string, unknown>();
function fixtureData(path: string) {
  const key = path.replace(/^\.client\./, '').replace(/^\./, '');
  return operationsFlowQueryData[new URLSearchParams(location.search).get('screen') ?? '']?.[key] ?? gapPharmacyHotelQueryData[key] ?? gapRestaurantQueryData[key] ?? platformQueryData[key] ?? additionalQueryData[key] ?? pharmacyQueryData[key] ?? managementQueryData[key] ?? generalQueryData[key] ?? (/\.(get|effective|detail)/.test(path) ? null : []);
}
function node(path = ''): unknown {
  if (nodes.has(path)) return nodes.get(path);
  const proxy = new Proxy(() => {}, { get: (_target, key) => {
    if (key === 'query') return async () => fixtureData(path);
    if (key === 'useUtils') return () => node(path);
    if (key === 'fetch') return async () => ({plans: [], mealOptions: [{value: 'BREAKFAST', label: 'Breakfast'}], standardCodes: ['EP']});
    if (key === 'invalidate') return async () => {};
    if (key === 'useInfiniteQuery') return () => ({ data: generalQueryData[path.slice(1)] ?? {pages:[]}, isLoading: false, isFetching: false, hasNextPage: false, fetchNextPage: async () => {} });
    if (key === 'useQuery' && path.endsWith('.team.getAll')) return () => ({data: [{id: 'fixture-member-1', name: 'Amina Example', title: 'Operations', avatar: null}], isPending: false});
    if (key === 'useQuery' && !path.startsWith('.pharmacyOwnerImport')) return () => ({ data: fixtureData(path), isPending: false, isLoading: false, isSuccess: true, isError: false, error: null, refetch: async () => ({ data: [] }) });
    if (key === 'useQuery') return () => ({ isLoading: mode() === 'loading', isError: ['error','denied'].includes(mode()), data: mode() === 'empty' ? { branches: [], locations: [] } : { branches, locations }, isPending: mode() === 'loading', error: ['error', 'denied'].includes(mode()) ? { data: { code: mode() === 'denied' ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR' } } : null, refetch: async () => {} });
    if (key === 'useMutation') return () => useMutation(path);
    return node(`${path}.${String(key)}`);
  } });
  nodes.set(path, proxy);
  return proxy;
}
export const trpc = node();
