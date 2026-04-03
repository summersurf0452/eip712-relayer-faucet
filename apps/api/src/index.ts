import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ErrorCode } from "@eip712-faucet/shared";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { challengeRoutes } from "./routes/challenges.js";
import { claimRoutes } from "./routes/claims.js";
import { faucetRoutes } from "./routes/faucet.js";

const app = Fastify({
  logger: { level: "info" },
  disableRequestLogging: true,
  trustProxy: 1,
});

// ── 플러그인 ─────────────────────────────────────
const ALLOWED_ORIGINS = env.FRONTEND_URL
  ? env.FRONTEND_URL.split(",").map((o) => o.trim())
  : [];
await app.register(cors, {
  origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
  methods: ["GET", "POST"],
});

await app.register(rateLimit, {
  global: false, // 라우트별로 개별 설정
  addHeaders: {
    "retry-after": true,
  },
  errorResponseBuilder: (_req, context) => ({
    statusCode: context.ban ? 403 : 429,
    code: ErrorCode.RATE_LIMITED,
    message: `Rate limit exceeded. Retry in ${context.after}.`,
  }),
});

// ── 전역 에러 핸들러 ─────────────────────────────────
app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  reply.status(500).send({
    code: "INTERNAL_ERROR",
    message: "Internal server error",
  });
});

// ── 헬스체크 ──────────────────────────────────────
app.get("/healthz", async () => ({ ok: true }));

app.get("/readyz", async (_req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return reply.send({ ok: true, db: "connected" });
  } catch {
    return reply.status(503).send({ ok: false, db: "disconnected" });
  }
});

// ── API 라우트 ────────────────────────────────────
await app.register(challengeRoutes, { prefix: "/api/v1" });
await app.register(claimRoutes, { prefix: "/api/v1" });
await app.register(faucetRoutes, { prefix: "/api/v1" });

// ── 시작 ─────────────────────────────────────────
try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`API listening on port ${env.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
