// viem 클라이언트 + Faucet ABI 정의

import { createPublicClient, createWalletClient, defineChain, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat, holesky, localhost, mainnet, sepolia } from "viem/chains";
import { getChainMetadata } from "@eip712-faucet/shared";
import { env } from "./env.js";

export const FAUCET_ABI = [
  {
    name: "drip",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "requestId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "paused",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

export const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY);

const knownChains: readonly Chain[] = [mainnet, sepolia, holesky, hardhat, localhost];

function resolveChain(): Chain {
  const configuredChain = knownChains.find((chain) => chain.id === env.CHAIN_ID);
  if (configuredChain) return configuredChain;

  const metadata = getChainMetadata(env.CHAIN_ID);
  return defineChain({
    id: env.CHAIN_ID,
    name: metadata.name,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [env.RPC_URL] },
      public: { http: [env.RPC_URL] },
    },
    blockExplorers: metadata.explorerBaseUrl
      ? {
          default: {
            name: "Explorer",
            url: metadata.explorerBaseUrl,
          },
        }
      : undefined,
  });
}

export const chain = resolveChain();

export const publicClient = createPublicClient({
  chain,
  transport: http(env.RPC_URL),
});

export const walletClient = createWalletClient({
  account,
  chain,
  transport: http(env.RPC_URL),
});
