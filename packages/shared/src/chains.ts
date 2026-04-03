export const DEFAULT_CHAIN_ID = 11155111;

export interface ChainMetadata {
  id: number;
  name: string;
  explorerBaseUrl: string | null;
}

const CHAIN_METADATA_BY_ID: Record<number, ChainMetadata> = {
  1: {
    id: 1,
    name: "Ethereum",
    explorerBaseUrl: "https://etherscan.io",
  },
  1337: {
    id: 1337,
    name: "Localhost",
    explorerBaseUrl: null,
  },
  17000: {
    id: 17000,
    name: "Holesky",
    explorerBaseUrl: "https://holesky.etherscan.io",
  },
  31337: {
    id: 31337,
    name: "Local Hardhat",
    explorerBaseUrl: null,
  },
  11155111: {
    id: 11155111,
    name: "Sepolia",
    explorerBaseUrl: "https://sepolia.etherscan.io",
  },
};

export function getChainMetadata(chainId: number): ChainMetadata {
  return CHAIN_METADATA_BY_ID[chainId] ?? {
    id: chainId,
    name: `Chain ${chainId}`,
    explorerBaseUrl: null,
  };
}

export function getExplorerBaseUrl(chainId: number, override?: string | null): string | null {
  const normalizedOverride = override?.trim();
  return normalizedOverride && normalizedOverride.length > 0
    ? normalizedOverride
    : getChainMetadata(chainId).explorerBaseUrl;
}
