import 'server-only';

export function medicineConnectorHealth() {
  return [
    {
      id: 'manual-file',
      label: 'Manual CSV / Excel',
      enabled: true,
      status: 'READY' as const,
      detail: 'Explicit tenant upload; regulated changes require pharmacist confirmation',
    },
  ];
}
