// tx_attempt receipt를 기준으로 claim 상태를 확정한다.
// 또한 lease가 만료된 broadcasting claim을 복구하고, retryable claim을 다시 큐잉한다.

import { TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { prisma } from "./db.js";
import { publicClient } from "./chain.js";
import { env } from "./env.js";

const MAX_TOTAL_ATTEMPTS = 3;
const REQUIRED_CONFIRMATIONS = BigInt(Math.max(env.CONFIRMATIONS_REQUIRED, 1));
const BROADCAST_TIMEOUT_MS = env.BROADCAST_TIMEOUT_SECONDS * 1000;

export async function reconcile(): Promise<void> {
  await Promise.all([
    reconcileTransactionAttempts(),
    recoverExpiredLeases(),
    requeueRetryable(),
    cleanupExpiredChallenges(),
  ]);
}

// ── sent/dropped attempt → confirmed / reverted / dropped ────────
async function reconcileTransactionAttempts(): Promise<void> {
  const attempts = await prisma.txAttempt.findMany({
    where: {
      status: { in: ["sent", "dropped"] },
      txHash: { not: null },
      claim: {
        status: { not: "confirmed" },
      },
    },
    include: {
      claim: true,
    },
  });

  if (attempts.length === 0) return;

  let latestBlockNumber: bigint | null = null;

  for (const attempt of attempts) {
    if (!attempt.txHash) continue;

    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: attempt.txHash as `0x${string}`,
      });

      latestBlockNumber ??= await publicClient.getBlockNumber();
      const confirmations = latestBlockNumber >= receipt.blockNumber
        ? latestBlockNumber - receipt.blockNumber + 1n
        : 0n;

      if (confirmations < REQUIRED_CONFIRMATIONS) continue;

      if (receipt.status === "success") {
        await markAttemptConfirmed(attempt.claim.id, attempt.id, attempt.txHash);
        console.log({ event: "claim_confirmed", claimId: attempt.claim.id, txHash: attempt.txHash, confirmations: confirmations.toString() });
      } else {
        await markAttemptReverted(
          attempt.claim.id,
          attempt.id,
          attempt.txHash,
          attempt.claim.txHash
        );
        console.log({ event: "claim_reverted", claimId: attempt.claim.id, txHash: attempt.txHash });
      }
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) {
        try {
          const txStillKnown = await isTransactionKnown(attempt.txHash as `0x${string}`);
          if (!txStillKnown) {
            await maybeMarkAttemptDropped(attempt.claim, attempt.id, attempt.txHash);
          }
        } catch (lookupError) {
          console.warn({ event: "tx_lookup_failed", claimId: attempt.claim.id, error: String(lookupError) });
        }
        continue;
      }

      if (err instanceof TransactionNotFoundError) {
        await maybeMarkAttemptDropped(attempt.claim, attempt.id, attempt.txHash);
        continue;
      }

      // RPC 오류 — 다음 주기에 재시도
      console.warn({ event: "receipt_fetch_failed", claimId: attempt.claim.id, error: String(err) });
    }
  }
}

async function isTransactionKnown(hash: `0x${string}`): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash });
    return true;
  } catch (err) {
    if (err instanceof TransactionNotFoundError) return false;
    throw err;
  }
}

async function maybeMarkAttemptDropped(
  claim: {
    id: string;
    status: string;
    txHash: string | null;
    broadcastedAt: Date | null;
  },
  attemptId: string,
  txHash: string
): Promise<void> {
  if (claim.status !== "broadcasted") return;
  if (claim.txHash !== txHash) return;
  if (!claim.broadcastedAt) return;
  if (Date.now() - claim.broadcastedAt.getTime() < BROADCAST_TIMEOUT_MS) return;

  const failureMessage = `No receipt found within ${env.BROADCAST_TIMEOUT_SECONDS} seconds`;

  await prisma.$transaction(async (tx) => {
    await tx.txAttempt.update({
      where: { id: attemptId },
      data: {
        status: "dropped",
        errorCode: "BROADCAST_TIMEOUT",
        errorMessage: failureMessage,
      },
    });

    await tx.claim.update({
      where: { id: claim.id },
      data: {
        status: "failed_retryable",
        txHash: null,
        failureCode: "BROADCAST_TIMEOUT",
        failureMessage,
      },
    });
  });

  console.warn({ event: "tx_dropped", claimId: claim.id, txHash });
}

async function markAttemptConfirmed(
  claimId: string,
  attemptId: string,
  txHash: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.claim.update({
      where: { id: claimId },
      data: {
        status: "confirmed",
        txHash,
        confirmedAt: new Date(),
        finalizedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
    });

    await tx.txAttempt.update({
      where: { id: attemptId },
      data: {
        status: "confirmed",
        errorCode: null,
        errorMessage: null,
      },
    });

    await tx.txAttempt.updateMany({
      where: {
        claimId,
        id: { not: attemptId },
        status: { in: ["sent", "dropped"] },
      },
      data: {
        status: "replaced",
        errorCode: "SUPERSEDED_BY_CONFIRMED_ATTEMPT",
        errorMessage: "Another transaction attempt confirmed successfully",
      },
    });
  });
}

async function markAttemptReverted(
  claimId: string,
  attemptId: string,
  txHash: string,
  currentClaimTxHash: string | null
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.txAttempt.update({
      where: { id: attemptId },
      data: {
        status: "reverted",
        errorCode: "TX_REVERTED",
        errorMessage: "Transaction reverted on-chain",
      },
    });

    if (currentClaimTxHash === txHash) {
      await tx.claim.update({
        where: { id: claimId },
        data: {
          status: "failed_permanent",
          failureCode: "TX_REVERTED",
          failureMessage: "Transaction reverted on-chain",
          finalizedAt: new Date(),
        },
      });
    }
  });
}

// ── lease 만료된 broadcasting claim 복구 ─────────────────────────
// Worker가 crash했을 때 claim이 broadcasting에서 영원히 멈추는 것을 방지
// txHash가 있는 attempt가 존재하면 → broadcasted (mempool에 있을 수 있음)
// txHash가 없으면 → queued로 안전하게 재시도
async function recoverExpiredLeases(): Promise<void> {
  const expiredClaims = await prisma.claim.findMany({
    where: {
      status: "broadcasting",
      leaseExpiresAt: { lt: new Date() },
    },
    select: { id: true },
  });

  if (expiredClaims.length === 0) return;

  for (const { id } of expiredClaims) {
    const attemptWithTx = await prisma.txAttempt.findFirst({
      where: { claimId: id, txHash: { not: null }, status: { notIn: ["dropped", "reverted", "replaced"] } },
      orderBy: { attemptNo: "desc" },
    });

    if (attemptWithTx) {
      // tx가 mempool에 있을 수 있음 → broadcasted로 전환하여 receipt 추적
      await prisma.claim.update({
        where: { id },
        data: {
          status: "broadcasted",
          txHash: attemptWithTx.txHash,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      console.log({ event: "lease_recovered_to_broadcasted", claimId: id, txHash: attemptWithTx.txHash });
    } else {
      // tx 미전송 → queued로 안전하게 복귀
      await prisma.claim.update({
        where: { id },
        data: { status: "queued", leaseOwner: null, leaseExpiresAt: null },
      });
      console.log({ event: "lease_recovered_to_queued", claimId: id });
    }
  }
}

// ── failed_retryable → queued (재시도) ───────────────────────────
async function requeueRetryable(): Promise<void> {
  const maxRetries = Math.max(MAX_TOTAL_ATTEMPTS - 1, 0);

  // queueAttempts는 이미 수행한 retry 횟수다. 초기 시도 1회를 포함해 총 3번까지만 시도한다.
  // Exponential backoff: 30s, 60s, 120s (attempt 0, 1, 2)
  const retryable = await prisma.claim.findMany({
    where: {
      status: "failed_retryable",
      queueAttempts: { lt: maxRetries },
    },
    select: { id: true, queueAttempts: true },
  });

  for (const claim of retryable) {
    const delaySec = 30 * Math.pow(2, claim.queueAttempts);
    const retryAt = new Date(Date.now() + delaySec * 1000);
    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        status: "queued",
        queueAttempts: { increment: 1 },
        queuedAt: retryAt,
      },
    });
  }

  const requeued = { count: retryable.length };

  // 최대 시도 초과 → 영구 실패
  await prisma.claim.updateMany({
    where: {
      status: "failed_retryable",
      queueAttempts: { gte: maxRetries },
    },
    data: {
      status: "failed_permanent",
      failureCode: "MAX_ATTEMPTS_EXCEEDED",
      failureMessage: `Failed after ${MAX_TOTAL_ATTEMPTS} total attempts`,
      finalizedAt: new Date(),
    },
  });

  if (requeued.count > 0) {
    console.log({ event: "claims_requeued", count: requeued.count });
  }
}

// ── 만료된 issued challenge 정리 — DB 무한 증가 방지 ──────────────
// TTL이 지난 issued challenge를 expired로 마킹하고, 오래된 expired를 삭제
async function cleanupExpiredChallenges(): Promise<void> {
  // 1. 만료된 issued → expired 마킹
  const expired = await prisma.claimChallenge.updateMany({
    where: {
      status: "issued",
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired" },
  });

  // 2. 7일 이상 된 expired/cancelled challenge 삭제
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const deleted = await prisma.claimChallenge.deleteMany({
    where: {
      status: { in: ["expired", "cancelled"] },
      createdAt: { lt: cutoff },
    },
  });

  if (expired.count > 0 || deleted.count > 0) {
    console.log({ event: "challenge_cleanup", expired: expired.count, deleted: deleted.count });
  }
}
