// POST /api/v1/claim-challenges
// 서버가 one-time challenge를 발급한다.

import { FastifyInstance } from "fastify";
import { randomBytes } from "crypto";
import { isAddress } from "viem";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { buildDomain } from "../lib/eip712.js";
import { hashIp } from "../lib/ipHash.js";
import { CLAIM_CHALLENGE_TYPES, ErrorCode } from "@eip712-faucet/shared";

const bodySchema = z.object({
  recipient: z.string().refine(isAddress, "Invalid EVM address"),
});

export async function challengeRoutes(app: FastifyInstance) {
  app.post("/claim-challenges", {
    config: {
      rateLimit: {
        max: env.RATE_LIMIT_MAX_CHALLENGE,
        timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
      },
    },
  }, async (req, reply) => {
    // 입력 검증
    const parse = bodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ code: ErrorCode.INVALID_RECIPIENT, message: "Invalid recipient address" });
    }

    const { recipient } = parse.data;
    const ipHash = hashIp(req.ip);

    // recipient에 이미 처리 중인 claim이 있으면 차단 (worker 낭비 방지)
    const activeClaim = await prisma.claim.findFirst({
      where: {
        recipient: recipient.toLowerCase(),
        status: { in: ["queued", "broadcasting", "broadcasted"] },
      },
    });
    if (activeClaim) {
      return reply.status(429).send({ code: ErrorCode.CLAIM_IN_PROGRESS, message: "A claim is already being processed for this address" });
    }

    // 이미 유효한 issued challenge가 있으면 재사용
    const existing = await prisma.claimChallenge.findFirst({
      where: {
        recipient: recipient.toLowerCase(),
        status: "issued",
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      const domain = buildDomain();
      return reply.send(buildResponse(existing, domain));
    }

    // 새 challenge 생성
    const challengeId = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
    const deadline = Math.floor(Date.now() / 1000) + env.CHALLENGE_TTL_SECONDS;
    const expiresAt = new Date(deadline * 1000);

    const domain = buildDomain();

    const challenge = await prisma.claimChallenge.create({
      data: {
        challengeId,
        recipient: recipient.toLowerCase(),
        chainId: env.CHAIN_ID,
        verifyingContract: env.FAUCET_ADDRESS.toLowerCase(),
        expiresAt,
        ipHash,
      },
    });

    return reply.status(201).send(buildResponse(challenge, domain));
  });
}

function buildResponse(
  challenge: { challengeId: string; recipient: string; expiresAt: Date },
  domain: ReturnType<typeof buildDomain>
) {
  const deadline = Math.floor(challenge.expiresAt.getTime() / 1000);

  return {
    challengeId: challenge.challengeId,
    recipient: challenge.recipient,
    deadline,
    domain,
    types: CLAIM_CHALLENGE_TYPES,
    message: {
      recipient: challenge.recipient,
      challengeId: challenge.challengeId,
      deadline,
    },
    expiresAt: challenge.expiresAt.toISOString(),
  };
}
