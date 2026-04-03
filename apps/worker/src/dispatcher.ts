// Worker의 핵심: queued claim을 DB에서 꺼내서 온체인으로 전송한다.

import { getAddress } from "viem";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { publicClient, walletClient, account, FAUCET_ABI } from "./chain.js";

const LEASE_DURATION_MS = env.LEASE_DURATION_SECONDS * 1000;

export async function dispatch(): Promise<void> {
  // ── Step 1+2: SELECT FOR UPDATE SKIP LOCKED + broadcasting 전환을 원자적으로 ──
  // 단일 트랜잭션으로 묶어서 advisory lock이 깨져도 중복 pick-up을 방지한다.
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS);
  const now = new Date();

  const picked = await prisma.$queryRaw<{ id: string; recipient: string; requestId: string }[]>`
    UPDATE claims
    SET status = 'broadcasting',
        "leaseOwner" = ${env.WORKER_ID},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "broadcastingAt" = ${now},
        "updatedAt" = ${now}
    WHERE id = (
      SELECT id FROM claims
      WHERE status = 'queued'
        AND "queuedAt" <= ${now}
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, recipient, "requestId"
  `;

  if (picked.length === 0) return; // 처리할 claim 없음

  const claim = picked[0];
  const claimId = claim.id;

  console.log({ event: "claim_picked", claimId, requestId: claim.requestId });

  // tx_attempt 레코드 생성
  const existingAttempts = await prisma.txAttempt.count({ where: { claimId } });
  const attempt = await prisma.txAttempt.create({
    data: {
      claimId,
      attemptNo: existingAttempts + 1,
      relayerAddress: account.address.toLowerCase(),
    },
  });

  // txHash를 try 밖에서 추적 — broadcast 성공 후 DB 실패 시 복구용
  let txHash: `0x${string}` | undefined;

  try {
    // ── Step 3: simulateContract — revert될 tx를 미리 감지 ───────────
    await publicClient.simulateContract({
      address: env.FAUCET_ADDRESS,
      abi: FAUCET_ABI,
      functionName: "drip",
      args: [getAddress(claim.recipient), claim.requestId as `0x${string}`],
      account: account.address,
    });

    await prisma.txAttempt.update({
      where: { id: attempt.id },
      data: { status: "simulated" },
    });

    // ── Step 4: 현재 nonce 조회 ───────────────────────────────────────
    const nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    // ── Step 5: 가스 추정 ─────────────────────────────────────────────
    const gasEstimate = await publicClient.estimateContractGas({
      address: env.FAUCET_ADDRESS,
      abi: FAUCET_ABI,
      functionName: "drip",
      args: [getAddress(claim.recipient), claim.requestId as `0x${string}`],
      account: account.address,
    });

    const feeData = await publicClient.estimateFeesPerGas();

    // ── Step 5.5: gas price cap — 비정상 가스비로 relayer ETH 소진 방지 ──
    const maxAllowed = BigInt(env.MAX_FEE_PER_GAS_GWEI) * 10n ** 9n;
    if (feeData.maxFeePerGas && feeData.maxFeePerGas > maxAllowed) {
      const msg = `Gas price ${feeData.maxFeePerGas} exceeds cap ${maxAllowed}`;
      console.warn({ event: "gas_too_high", claimId, maxFeePerGas: feeData.maxFeePerGas.toString(), cap: maxAllowed.toString() });
      await prisma.$transaction([
        prisma.claim.update({
          where: { id: claimId },
          data: {
            status: "failed_retryable",
            failureCode: "GAS_PRICE_TOO_HIGH",
            failureMessage: msg,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        }),
        prisma.txAttempt.update({
          where: { id: attempt.id },
          data: { status: "failed", errorCode: "GAS_PRICE_TOO_HIGH", errorMessage: msg },
        }),
      ]);
      return;
    }

    // ── Step 6: tx 서명 + 전송 ────────────────────────────────────────
    txHash = await walletClient.writeContract({
      address: env.FAUCET_ADDRESS,
      abi: FAUCET_ABI,
      functionName: "drip",
      args: [getAddress(claim.recipient), claim.requestId as `0x${string}`],
      nonce,
      gas: (gasEstimate * 120n) / 100n, // 20% 여유
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
    });

    console.log({ event: "tx_sent", claimId, txHash, nonce });

    // ── Step 7: DB 상태 업데이트 → broadcasted ────────────────────────
    await prisma.$transaction([
      prisma.claim.update({
        where: { id: claimId },
        data: {
          status: "broadcasted",
          txHash,
          broadcastedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      prisma.txAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "sent",
          txHash,
          chainNonce: BigInt(nonce),
          gasEstimate,
          maxFeePerGas: feeData.maxFeePerGas ?? null,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? null,
        },
      }),
    ]);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // ── broadcast 성공 후 DB write 실패 — txHash 복구 시도 ──────────
    // tx는 이미 mempool에 있으므로 반드시 추적 가능하게 해야 한다
    if (txHash) {
      console.error({ event: "db_write_after_broadcast_failed", claimId, txHash, error: errorMessage });
      try {
        await prisma.$transaction([
          prisma.claim.update({
            where: { id: claimId },
            data: {
              status: "broadcasted",
              txHash,
              broadcastedAt: new Date(),
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          }),
          prisma.txAttempt.update({
            where: { id: attempt.id },
            data: { status: "sent", txHash },
          }),
        ]);
        console.log({ event: "tx_hash_recovered", claimId, txHash });
      } catch (retryErr) {
        // DB 자체가 다운된 경우 — 로그로 txHash 보존 (수동 복구용)
        console.error({
          event: "CRITICAL_tx_hash_orphaned",
          claimId,
          txHash,
          requestId: claim.requestId,
          error: String(retryErr),
        });
      }
      return;
    }

    // ── broadcast 전 실패 — 기존 로직 ─────────────────────────────────
    const isDeterministic = isDeterministicRevert(errorMessage);

    console.error({ event: "dispatch_error", claimId, error: errorMessage, isDeterministic });

    // deterministic revert → 영구 실패
    // 일시적 오류 → 재시도 가능 상태로
    await prisma.$transaction([
      prisma.claim.update({
        where: { id: claimId },
        data: {
          status: isDeterministic ? "failed_permanent" : "failed_retryable",
          failureCode: isDeterministic ? "SIMULATION_REVERTED" : "TRANSIENT_ERROR",
          failureMessage: errorMessage,
          finalizedAt: isDeterministic ? new Date() : null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      prisma.txAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "failed",
          errorCode: isDeterministic ? "SIMULATION_REVERTED" : "TRANSIENT_ERROR",
          errorMessage,
        },
      }),
    ]);
  }
}

// 온체인 revert 메시지로 deterministic 실패 여부 판별
function isDeterministicRevert(message: string): boolean {
  const deterministicErrors = [
    "CooldownActive",
    "RequestAlreadyProcessed",
    "EpochBudgetExceeded",
    "InsufficientFaucetBalance",
    "EnforcedPause",
    "ZeroAddress",
  ];
  return deterministicErrors.some((e) => message.includes(e));
}
