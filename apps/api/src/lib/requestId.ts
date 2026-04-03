// requestId 생성: keccak256(abi.encode(challengeId, recipient, chainId, faucetAddress))
// deterministic하게 생성하여 DB에 저장하고, Worker는 저장된 값을 그대로 사용한다.

import { keccak256, encodeAbiParameters, parseAbiParameters, getAddress } from "viem";
import { env } from "../env.js";

export function generateRequestId(challengeId: string, recipient: string): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, address, uint256, address"),
      [
        challengeId as `0x${string}`,
        getAddress(recipient),
        BigInt(env.CHAIN_ID),
        env.FAUCET_ADDRESS,
      ]
    )
  );
}
