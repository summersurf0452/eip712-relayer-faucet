// EIP-712 서명 생성·검증 유틸리티

import { verifyTypedData, getAddress } from "viem";
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  CLAIM_CHALLENGE_TYPES,
} from "@eip712-faucet/shared";
import { env } from "../env.js";

export function buildDomain() {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: env.CHAIN_ID,
    verifyingContract: env.FAUCET_ADDRESS,
  } as const;
}

export async function recoverSigner(
  recipient: string,
  challengeId: string,
  deadline: bigint,
  signature: `0x${string}`
): Promise<string> {
  const domain = buildDomain();

  const message = {
    recipient: getAddress(recipient),
    challengeId: challengeId as `0x${string}`,
    deadline,
  };

  // verifyTypedData는 내부적으로 ecrecover를 수행한다
  const valid = await verifyTypedData({
    address: getAddress(recipient),
    domain,
    types: CLAIM_CHALLENGE_TYPES,
    primaryType: "ClaimChallenge",
    message,
    signature,
  });

  if (!valid) throw new Error("Signature verification failed");

  return getAddress(recipient);
}
