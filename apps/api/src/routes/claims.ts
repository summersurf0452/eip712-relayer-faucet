// POST /api/v1/claims        — 서명된 challenge를 소비하여 claim 생성
// GET  /api/v1/claims/:id   — claim 상태 조회

import { FastifyInstance } from "fastify";
import { isHex } from "viem";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { recoverSigner } from "../lib/eip712.js";
import { generateRequestId } from "../lib/requestId.js";
import { ErrorCode, type PublicClaimFailureCode } from "@eip712-faucet/shared";

function normalizeFailureCode(internal: string | null): PublicClaimFailureCode | null {
  if (!internal) return null;
  switch (internal) {
    case "SIMULATION_REVERTED":
    case "TX_REVERTED":
      return "REJECTED";
    case "GAS_PRICE_TOO_HIGH":
    case "BROADCAST_TIMEOUT":
    case "TRANSIENT_ERROR":
    case "MAX_ATTEMPTS_EXCEEDED":
      return "SERVICE_BUSY";
    default:
      return null;
  }
}

const createClaimBody = z.object({
  challengeId: z.string().refine((v) => isHex(v) && v.length === 66, "Invalid challengeId"),
  signature: z.string().refine((v) => isHex(v) && v.length === 132, "Invalid signature (expected 65 bytes)"),
});

const claimIdParam = z.string().uuid("Invalid claimId format");

export async function claimRoutes(app: FastifyInstance) {
  // ── POST /claims ──────────────────────────────────────────────────
  app.post("/claims", {
    config: {
      rateLimit: {
        max: env.RATE_LIMIT_MAX_CLAIM,
        timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
      },
    },
  }, async (req, reply) => {
    const parse = createClaimBody.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ code: ErrorCode.INVALID_SIGNATURE, message: "Invalid request body" });
    }

    const { challengeId, signature } = parse.data;

    // 1. challenge 조회
    const challenge = await prisma.claimChallenge.findUnique({
      where: { challengeId },
    });

    if (!challenge) {
      return reply.status(400).send({ code: ErrorCode.INVALID_SIGNATURE, message: "Challenge not found" });
    }

    // 2. 상태 확인 (early check — authoritative check is the CAS below)
    if (challenge.status !== "issued") {
      return reply.status(400).send({ code: ErrorCode.CHALLENGE_ALREADY_CONSUMED, message: "Challenge already consumed" });
    }

    // 3. 만료 확인
    if (challenge.expiresAt < new Date()) {
      await prisma.claimChallenge.update({ where: { id: challenge.id }, data: { status: "expired" } });
      return reply.status(400).send({ code: ErrorCode.CHALLENGE_EXPIRED, message: "Challenge expired" });
    }

    // 4. 서명 검증 (ecrecover)
    const deadline = BigInt(Math.floor(challenge.expiresAt.getTime() / 1000));
    let signer: string;
    try {
      signer = await recoverSigner(challenge.recipient, challenge.challengeId, deadline, signature as `0x${string}`);
    } catch {
      return reply.status(400).send({ code: ErrorCode.INVALID_SIGNATURE, message: "Signature verification failed" });
    }

    // 5. signer == recipient 확인
    if (signer.toLowerCase() !== challenge.recipient.toLowerCase()) {
      return reply.status(400).send({ code: ErrorCode.INVALID_SIGNATURE, message: "Signer does not match recipient" });
    }

    // 6. requestId 생성
    const requestId = generateRequestId(challenge.challengeId, challenge.recipient);

    // 7. Compare-and-set: challenge consumed + claim queued atomically
    //    updateMany with status condition prevents TOCTOU race
    try {
      const claim = await prisma.$transaction(async (tx) => {
        const consumed = await tx.claimChallenge.updateMany({
          where: { id: challenge.id, status: "issued", expiresAt: { gte: new Date() } },
          data: { status: "consumed", consumedAt: new Date() },
        });

        if (consumed.count === 0) {
          throw new Error("CHALLENGE_CONSUMED_OR_EXPIRED");
        }

        return tx.claim.create({
          data: {
            requestId,
            recipient: challenge.recipient,
            signer: signer.toLowerCase(),
            signature,
            challengeId: challenge.id,
            queuedAt: new Date(),
          },
        });
      });

      return reply.status(201).send({
        claimId: claim.id,
        status: claim.status,
        requestId: claim.requestId,
        recipient: claim.recipient,
        createdAt: claim.createdAt.toISOString(),
      });
    } catch (e) {
      if (e instanceof Error && e.message === "CHALLENGE_CONSUMED_OR_EXPIRED") {
        return reply.status(400).send({ code: ErrorCode.CHALLENGE_ALREADY_CONSUMED, message: "Challenge already consumed or expired" });
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.status(409).send({ code: ErrorCode.DUPLICATE_CLAIM, message: "Claim already exists" });
      }
      throw e;
    }
  });

  // ── GET /claims/:claimId ──────────────────────────────────────────
  app.get<{ Params: { claimId: string } }>("/claims/:claimId", async (req, reply) => {
    const parse = claimIdParam.safeParse(req.params.claimId);
    if (!parse.success) {
      return reply.status(400).send({ code: ErrorCode.NOT_FOUND, message: "Invalid claimId format" });
    }
    const claimId = parse.data;

    const claim = await prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      return reply.status(404).send({ code: ErrorCode.NOT_FOUND, message: "Claim not found" });
    }

    return reply.send({
      claimId: claim.id,
      status: claim.status,
      recipient: claim.recipient,
      requestId: claim.requestId,
      txHash: claim.txHash ?? null,
      failureCode: normalizeFailureCode(claim.failureCode),
      createdAt: claim.createdAt.toISOString(),
      updatedAt: claim.updatedAt.toISOString(),
    });
  });
}
