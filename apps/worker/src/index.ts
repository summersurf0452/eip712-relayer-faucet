// Worker 진입점
// 단일 active signer 보장 + 폴링 루프

import { prisma } from "./db.js";
import { env } from "./env.js";
import { dispatch } from "./dispatcher.js";
import { reconcile } from "./reconciler.js";

console.log({ event: "worker_starting", workerId: env.WORKER_ID });

// ── Advisory lock: 동시에 두 개의 worker가 뜨는 것을 방지 ──────────
// PostgreSQL advisory lock은 세션이 살아있는 동안 유지된다.
const LOCK_KEY = 7712345; // 임의의 고유 정수

async function acquireAdvisoryLock(): Promise<boolean> {
  const result = await prisma.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(${LOCK_KEY})
  `;
  return result[0].pg_try_advisory_lock;
}

const locked = await acquireAdvisoryLock();
if (!locked) {
  console.error({ event: "lock_failed", message: "Another worker is already running. Exiting." });
  process.exit(1);
}

console.log({ event: "lock_acquired", workerId: env.WORKER_ID });

// ── 메인 폴링 루프 ────────────────────────────────────────────────
async function loop(): Promise<void> {
  while (true) {
    try {
      // 1. 새 queued claim 처리
      await dispatch();

      // 2. broadcasted receipt 확인 + 만료 lease 복구 + retryable 재큐
      await reconcile();
    } catch (err) {
      console.error({ event: "loop_error", error: String(err) });
    }

    await sleep(env.POLL_INTERVAL_MS);
  }
}

// ── 종료 처리 ─────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error({ event: "unhandled_rejection", error: String(reason) });
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error({ event: "uncaught_exception", error: err.message });
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log({ event: "worker_stopping" });
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log({ event: "worker_stopping" });
  await prisma.$disconnect();
  process.exit(0);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await loop();
