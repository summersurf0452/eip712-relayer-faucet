import { defineChain, type Chain } from "viem";
import { hardhat, holesky, localhost, mainnet, sepolia } from "wagmi/chains";
import {
  DEFAULT_CHAIN_ID,
  getChainMetadata,
  getExplorerBaseUrl,
} from "@eip712-faucet/shared";

const knownChains: readonly Chain[] = [mainnet, sepolia, holesky, hardhat, localhost];

function parseChainId(value: string | undefined): number {
  const parsed = value ? Number(value) : DEFAULT_CHAIN_ID;
  return Number.isFinite(parsed) ? parsed : DEFAULT_CHAIN_ID;
}

export const faucetChainId = parseChainId(process.env.NEXT_PUBLIC_CHAIN_ID);
export const faucetChainMetadata = getChainMetadata(faucetChainId);
export const faucetExplorerBaseUrl = getExplorerBaseUrl(
  faucetChainId,
  process.env.NEXT_PUBLIC_RPC_EXPLORER_BASE_URL ?? null
);
export const faucetChainLabel = faucetChainMetadata.name;

const MAINNET_CHAIN_IDS = new Set([1]);
const rawIsTestnet = process.env.NEXT_PUBLIC_IS_TESTNET?.trim();
const isTestnetOverride = rawIsTestnet && rawIsTestnet.length > 0 ? rawIsTestnet : undefined;
export const isTestnet = isTestnetOverride !== undefined
  ? isTestnetOverride !== "false"
  : !MAINNET_CHAIN_IDS.has(faucetChainId);

const fallbackRpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "";

export const faucetChain =
  knownChains.find((chain) => chain.id === faucetChainId) ??
  defineChain({
    id: faucetChainId,
    name: faucetChainMetadata.name,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    rpcUrls: fallbackRpcUrl
      ? { default: { http: [fallbackRpcUrl] }, public: { http: [fallbackRpcUrl] } }
      : { default: { http: [] }, public: { http: [] } },
    blockExplorers: faucetExplorerBaseUrl
      ? {
          default: {
            name: "Explorer",
            url: faucetExplorerBaseUrl,
          },
        }
      : undefined,
  });

export function getExplorerUrl(path: `/${string}`): string | null {
  if (!faucetExplorerBaseUrl) return null;
  return new URL(path, `${faucetExplorerBaseUrl}/`).toString();
}
