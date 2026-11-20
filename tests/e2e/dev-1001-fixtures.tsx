import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RestaurantBranchSelect } from '../../src/components/restaurant/restaurant-branch-select';
import { RestaurantStaffSelect } from '../../src/components/restaurant/restaurant-staff-select';
import { RestaurantDeviceSelect } from '../../src/components/restaurant/restaurant-device-select';
import { RestaurantCameraWizard } from '../../src/components/restaurant/restaurant-camera-wizard';
import { OperatorSafeSelector } from '../../src/components/restaurant/operator-safe-selector';
import { TenderPad } from '../../src/components/restaurant/pos/tender-pad';
import { SplitBillDialog } from '../../src/components/restaurant/pos/split-bill-dialog';
import { OwnerImportWizard } from '../../src/components/pharmacy/owner-import-wizard';
import { SupportAccessForm } from '../../src/components/platform/support-access-form';
import { ReceiptDesigner } from '../../src/components/receipts/receipt-designer';
import { PageHeader } from '../../src/components/ui/page-header';
import { SectionCard } from '../../src/components/ui/section-card';
import { DEFAULT_RECEIPT_LAYOUT } from '../../src/lib/receipts/configuration';
import { gapPharmacyHotelScreens } from './dev-1001-gap-pharmacy-hotel-fixtures';
import { gapRestaurantScreens, gapRestaurantFetchResponses } from './dev-1001-gap-restaurant-fixtures';
import { platformScreens } from './dev-1001-gap-platform-fixtures';
import { gapFinanceScreens } from './dev-1001-gap-finance-fixtures';
import { extraScreens } from './dev-1001-extra-fixtures';
import { managementScreens } from './dev-1001-management-fixtures';
import { inventoryPageScreens } from './dev-1001-inventory-page-fixture';
import { additionalScreens, additionalFetchResponses } from './dev-1001-additional-fixtures';
import { pharmacyScreens } from './dev-1001-pharmacy-fixtures';
import { generalScreens, terminalFixtureResponses } from './dev-1001-general-fixtures';
import { EntitlementsProvider } from '../../src/components/entitlements-provider';

const state = new URLSearchParams(location.search).get('state') ?? 'default';
const unavailable = { loading: state === 'loading', error: state === 'error', disabled: state === 'disabled' };
const branches = [
  { id: 'branch-a', name: 'Garden branch', code: 'GDN', active: true, isDefault: true },
  { id: 'branch-b', name: 'Riverside branch', code: 'RIV', active: true, isDefault: false },
];
const staff = [{ id: 'staff-a', displayName: 'Sample cashier', role: 'CASHIER' }, { id: 'staff-b', displayName: 'Sample manager', role: 'MANAGER' }];
const devices = [{ id: 'device-a', name: 'Front desk', branch: branches[0], status: 'ACTIVE' }, { id: 'device-b', name: 'Service desk', branch: branches[1], status: 'ACTIVE' }];

// Only local, deterministic responses. This harness never reaches an application server.
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url in gapRestaurantFetchResponses) return Response.json(gapRestaurantFetchResponses[url]);
  if (url === '/api/restaurant/receipt-layout') {
    if (state === 'loading') return new Promise<Response>(() => {});
    return Response.json(state === 'error' ? { error: 'Fixture: receipt settings unavailable.' } : {
      branches: state === 'empty' ? [] : branches.map((branch) => ({ ...branch, revision: 1, layout: DEFAULT_RECEIPT_LAYOUT })),
    }, { status: state === 'error' ? 503 : 200 });
  }
  if (url === '/api/restaurant/print-bridge') return Response.json({branches: branches.map(branch=>({...branch,kitchenStations:[],config:{branchId:branch.id,routes:[]}}))});
  if (url in additionalFetchResponses) return Response.json(additionalFetchResponses[url]);
  if (url === '/api/restaurant/terminal/establish' && new URLSearchParams(location.search).get('screen') === 'restaurant-kds') return Response.json({...terminalFixtureResponses[url],device:{kind:'KDS',name:'Kitchen display',branchName:'Garden branch'}});
  if (url in terminalFixtureResponses) return Response.json(terminalFixtureResponses[url as keyof typeof terminalFixtureResponses]);
  if (url.startsWith('/api/')) return Response.json({ error: 'Fixture has no live service.' }, {status: 503});
  throw new Error(`Unexpected fixture request: ${url}`);
};

function RestaurantSelectors() {
  const [branch, setBranch] = useState('branch-a');
  const [person, setPerson] = useState('staff-a');
  const [device, setDevice] = useState('device-a');
  const [option, setOption] = useState('branch-a');
  return <><PageHeader eyebrow="Restaurant administration" heading="Branch, staff and device selectors" />
    <SectionCard title="Assignment"><form className="grid gap-5 md:grid-cols-2">
      <label className="space-y-2">Branch<RestaurantBranchSelect name="branchId" branches={state === 'empty' ? [] : branches} value={branch} onChange={setBranch} required {...unavailable} /></label>
      <label className="space-y-2">Staff member<RestaurantStaffSelect name="staffId" staff={state === 'empty' ? [] : staff} value={person} onChange={setPerson} required {...unavailable} /></label>
      <label className="space-y-2">Device<RestaurantDeviceSelect name="deviceId" devices={state === 'empty' ? [] : devices} value={device} onChange={setDevice} required {...unavailable} /></label>
      <label className="space-y-2">Active branch<OperatorSafeSelector label="Active branch" name="activeBranch" value={option} onChange={setOption} options={state === 'empty' ? [] : branches.map(({ id, name, code }) => ({ value: id, label: name, code }))} {...unavailable} forbidden={state === 'denied'} /></label>
    </form></SectionCard></>;
}
function CameraScreen() {
  return <><PageHeader eyebrow="Restaurant cameras" heading="Camera setup" /><RestaurantCameraWizard branches={branches} presets={[]} gateways={branches.map((branch, i) => ({ id: `gateway-${i}`, name: `Sample gateway ${i + 1}`, branchId: branch.id, status: 'ONLINE' }))} gatewaysLoading={state === 'loading'} gatewaysError={state === 'error'} busy={state === 'disabled'} onTest={async () => ({ outcome: 'unreachable' })} onSubmit={async () => {}} /></>;
}
function PosScreen() {
  return <><PageHeader eyebrow="Restaurant point of sale" heading="Checkout controls" /><SectionCard title="Bill 1042"><TenderPad billId="fixture-bill" amountDue="1250.00" disabled={state === 'disabled'} request={async () => { throw new Error('Fixture: payment was not sent.'); }} onApplied={() => {}} /><div className="mt-6"><SplitBillDialog items={[{ id: 'item-a', name: 'Vegetable wrap', quantity: 1, seatNumber: 1, modifiers: [] }, { id: 'item-b', name: 'Fresh lemonade', quantity: 1, seatNumber: 2, modifiers: [] }]} onSplit={async () => false} /></div></SectionCard></>;
}
const screens: Record<string, React.ReactNode> = {
  'restaurant-selectors': <RestaurantSelectors />,
  'restaurant-cameras': <CameraScreen />,
  'restaurant-pos': <PosScreen />,
  'pharmacy-import': <OwnerImportWizard />,
  'platform-support': <div className="platform-workspace"><PageHeader eyebrow="Platform support" heading="Audited support access" /><SectionCard title="Support session"><SupportAccessForm organizationId="isolated-fixture-organization" /></SectionCard></div>,
  'receipt-designer': <ReceiptDesigner />,
  ...extraScreens,
  ...gapFinanceScreens,
  ...platformScreens,
  ...gapRestaurantScreens,
  ...gapPharmacyHotelScreens,
  ...managementScreens,
  ...generalScreens,
  ...pharmacyScreens,
  ...additionalScreens,
  ...inventoryPageScreens,
};
const screen = new URLSearchParams(location.search).get('screen') ?? 'restaurant-selectors';
Object.assign(window, { dev1001Screens: Object.keys(screens) });
createRoot(document.getElementById('root')!).render(<EntitlementsProvider value={{organizationId:'fixture-org', vertical:'RESTAURANT',modules:[],enabledModules:['restaurant-core','restaurant-menu','restaurant-pos','restaurant-workforce','restaurant-loyalty','restaurant-catering','hr','admin'],limits:{},seatLimit:100,activeSeats:2}}><main className="min-h-screen min-w-0 bg-surface-base p-4 text-text-strong md:p-6"><div className={`mx-auto min-w-0 max-w-7xl${screen.startsWith('platform-') ? ' platform-workspace' : ''}`}>{screens[screen]}</div></main></EntitlementsProvider>);
