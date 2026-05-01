// GET /api/v1/faucet/status?recipient=0x...
// 사용자 경험 개선용. 최종 진실은 온체인이다.

import { FastifyInstance } from "fastify";
import { createPublicClient, http, isAddress, getAddress } from "viem";
import { ERC20_ABI, ErrorCode, FAUCET_ABI, type ReasonCode } from "@eip712-faucet/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";

// Module-scope client — 요청마다 새로 만들지 않음
const publicClient = createPublicClient({ transport: http(env.RPC_URL) });

export async function faucetRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { recipient?: string } }>("/faucet/status", {
    config: {
      rateLimit: {
        max: env.RATE_LIMIT_MAX_CHALLENGE,
        timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
      },
    },
  }, async (req, reply) => {
    const recipientParam = req.query.recipient;
    const recipient = recipientParam && isAddress(recipientParam) ? getAddress(recipientParam) : null;

    try {
      const [dripAmount, epochBudget, epochSpent, paused, tokenAddress] = await Promise.all([
        publicClient.readContract({ address: env.FAUCET_ADDRESS, abi: FAUCET_ABI, functionName: "dripAmount" }),
        publicClient.readContract({ address: env.FAUCET_ADDRESS, abi: FAUCET_ABI, functionName: "epochBudget" }),
        publicClient.readContract({ address: env.FAUCET_ADDRESS, abi: FAUCET_ABI, functionName: "epochSpent" }),
        publicClient.readContract({ address: env.FAUCET_ADDRESS, abi: FAUCET_ABI, functionName: "paused" }),
        publicClient.readContract({ address: env.FAUCET_ADDRESS, abi: FAUCET_ABI, functionName: "token" }),
      ]);

      const [faucetBalance, nextAt] = await Promise.all([
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [env.FAUCET_ADDRESS],
        }),
        recipient
          ? publicClient.readContract({
              address: env.FAUCET_ADDRESS,
              abi: FAUCET_ABI,
              functionName: "nextClaimAt",
              args: [recipient],
            })
          : Promise.resolve(null),
      ]);

      const epochBudgetRemaining = epochBudget > epochSpent ? epochBudget - epochSpent : 0n;

      // ── reasonCode 평가: user-first 우선순위 ──
      // CLAIM_IN_PROGRESS > COOLDOWN > PAUSED > UNAVAILABLE
      let eligible = true;
      let reasonCode: ReasonCode | null = null;
      let nextClaimAt: string | null = null;

      // 1. 개인별 blocker: active claim (recipient 필요, 독립 단계)
      if (recipient) {
        const activeClaim = await prisma.claim.findFirst({
          where: {
            recipient: recipient.toLowerCase(),
            status: { in: ["queued", "broadcasting", "broadcasted"] },
          },
        });
        if (activeClaim) {
          eligible = false;
          reasonCode = "CLAIM_IN_PROGRESS";
        }
      }

      // 2. 개인별 blocker: cooldown (recipient 필요)
      if (eligible && nextAt !== null) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (nextAt > now) {
          eligible = false;
          reasonCode = "COOLDOWN";
          nextClaimAt = new Date(Number(nextAt) * 1000).toISOString();
        }
      }

      // 3. 전역 상태: paused
      if (eligible && paused) {
        eligible = false;
        reasonCode = "PAUSED";
      }

      // 4. 전역 상태: budget 또는 balance 부족 (구체적 사유 미공개)
      if (eligible && (epochBudgetRemaining < dripAmount || faucetBalance < dripAmount)) {
        eligible = false;
        reasonCode = "UNAVAILABLE";
      }

      return reply.send({
        eligible,
        reasonCode,
        nextClaimAt,
        dripAmount: dripAmount.toString(),
      });
    } catch (err) {
      return reply.status(503).send({ code: ErrorCode.FAUCET_UNAVAILABLE, message: "Failed to fetch faucet status" });
    }
  });
}
