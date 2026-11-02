type ProviderIdentityNamespace = 'usr' | 'gst';

export function createMeetingProviderIdentity(
  namespace: ProviderIdentityNamespace,
  value: string
): string {
  if (!value) throw new Error('Meeting provider identity requires a non-empty value.');
  return `${namespace}:${value}`;
}

export function parseMeetingProviderIdentity(
  identity: string
): { namespace: ProviderIdentityNamespace | 'legacy'; value: string } | null {
  if (!identity) return null;
  const separator = identity.indexOf(':');
  if (separator === -1) return { namespace: 'legacy', value: identity };

  const namespace = identity.slice(0, separator);
  const value = identity.slice(separator + 1);
  if (!value || (namespace !== 'usr' && namespace !== 'gst')) return null;
  return { namespace, value };
}
