// 환경변수를 한 곳에서 파싱하고 검증한다.
// 앱 시작 시 누락된 필수 변수가 있으면 즉시 crash.

import {
  optionalEnv,
  optionalEnvInt,
  requireEnv,
  requireEnvInt,
} from "@eip712-faucet/shared";

export const env = {
  PORT: optionalEnvInt("PORT", "3001"),
  DATABASE_URL: requireEnv("DATABASE_URL"),
  RPC_URL: requireEnv("RPC_URL"),
  CHAIN_ID: requireEnvInt("CHAIN_ID"),
  FAUCET_ADDRESS: requireEnv("FAUCET_ADDRESS") as `0x${string}`,

  CHALLENGE_TTL_SECONDS: optionalEnvInt("CHALLENGE_TTL_SECONDS", "300"),
  IP_HMAC_SECRET: requireEnv("IP_HMAC_SECRET"),
  FRONTEND_URL: optionalEnv("FRONTEND_URL", ""),

  RATE_LIMIT_WINDOW_SECONDS: optionalEnvInt("RATE_LIMIT_WINDOW_SECONDS", "600"),
  RATE_LIMIT_MAX_CHALLENGE: optionalEnvInt("RATE_LIMIT_MAX_CHALLENGE", "10"),
  RATE_LIMIT_MAX_CLAIM: optionalEnvInt("RATE_LIMIT_MAX_CLAIM", "5"),
} as const;
