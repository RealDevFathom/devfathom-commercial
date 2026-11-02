export type AIMutationCapability = 'usage:write' | 'budget-alert:write';

export type AIMutationPrincipal = Readonly<{
  id: string;
  allow: readonly AIMutationCapability[];
  deny: readonly AIMutationCapability[];
}>;

/** Central, default-deny decision for platform-global AI background mutations. */
export function can(principal: AIMutationPrincipal, capability: AIMutationCapability): boolean {
  if (principal.deny.includes(capability)) return false;
  return principal.allow.includes(capability);
}

export const AI_METERING_PRINCIPAL: AIMutationPrincipal = Object.freeze({
  id: 'system:ai-metering',
  allow: Object.freeze(['usage:write', 'budget-alert:write'] as const),
  deny: Object.freeze([] as const),
});
