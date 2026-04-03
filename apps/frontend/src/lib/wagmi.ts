import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
  injectedWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { faucetChain } from "./chain";

// EOA wallets only — this faucet uses ecrecover-based signature verification
// which does not support EIP-1271 smart contract wallets (e.g. Safe).
export function createWagmiConfig() {
  const configured = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required. " +
        "Get one at https://cloud.reown.com",
      );
    }
    console.warn(
      "[wagmi] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is missing — " +
      "WalletConnect will not work. Get one at https://cloud.reown.com",
    );
  }

  const projectId = configured || "00000000000000000000000000000000";

  return getDefaultConfig({
    appName: "EIP-712 Relayer Faucet",
    projectId,
    chains: [faucetChain],
    ssr: false,
    wallets: [
      {
        groupName: "Supported",
        wallets: [metaMaskWallet, rainbowWallet, walletConnectWallet, injectedWallet],
      },
    ],
  });
}
