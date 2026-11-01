export function packConversionLabel(
  level: string,
  chain: readonly { level: string; unitsPerParent: number }[],
  units: number
) {
  if (units === 1) return '1 unit';
  if (chain.length <= 1) return `1 ${level} = ${units} units`;
  const steps: string[] = [];
  let running = 1;
  for (const step of chain.slice(1)) {
    running *= chain[steps.length]!.unitsPerParent;
    steps.push(`${running} ${step.level}${running === 1 ? '' : 's'}`);
  }
  return `1 ${level} = ${steps.join(' = ')} = ${units} units`;
}
