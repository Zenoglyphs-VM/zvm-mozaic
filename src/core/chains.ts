// Display names for the chains this app knows. The contract on each comes from
// deployments/ (see endpoint.ts), not from here.

export const CHAIN_NAMES: Record<number, string> = {
  7340469: 'ZVM devnet',
}

export function chainName(chainId: number | null): string {
  if (chainId === null) return 'Unknown chain'
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`
}
