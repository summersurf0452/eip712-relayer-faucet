// ──────────────── EIP-712 Domain ────────────────
export const EIP712_DOMAIN_NAME = "eip712-relayer-faucet" as const;
export const EIP712_DOMAIN_VERSION = "1" as const;

// ──────────────── Challenge ────────────────
export const CHALLENGE_TTL_SECONDS = 300; // 5분

// ──────────────── EIP-712 Types ────────────────
// wagmi/viem의 signTypedData에 직접 전달 가능한 형태
export const CLAIM_CHALLENGE_TYPES = {
  ClaimChallenge: [
    { name: "recipient", type: "address" },
    { name: "challengeId", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
